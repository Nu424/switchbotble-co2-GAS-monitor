import asyncio
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import nest_asyncio
from bleak import BleakScanner
from dotenv import load_dotenv

nest_asyncio.apply()
load_dotenv()

# SwitchBotのカンパニーID (0x0969)
COMPANY_ID = 2409


@dataclass
class Reading:
    """SwitchBot CO2メーターから取得した1サンプル。"""

    timestamp: str
    temperature_c: float
    humidity_pct: int
    co2_ppm: int
    device_mac: str


def parse_switchbot_data(data: bytes) -> tuple[float, int, int]:
    """SwitchBotのmanufacturer bytesを温湿度・CO2に変換する。

    Args:
        data: デバイスのmanufacturer広告バイト列。

    Returns:
        (temperature_c, humidity_pct, co2_ppm) のタプル。

    Raises:
        ValueError: manufacturerデータ長が不足している場合。
    """
    if len(data) < 15:
        raise ValueError("manufacturerデータ長が不足しているため解析できません。")

    # 温度: 下位4bitの小数部 + 符号付き整数部
    decimal_part = (data[8] & 0x0F) * 0.1
    integer_part = data[9] & 0x7F
    sign = 1 if (data[9] & 0x80) > 0 else -1
    temperature_c = (integer_part + decimal_part) * sign

    humidity_pct = data[10] & 0x7F
    co2_ppm = int.from_bytes(data[13:15], byteorder="big")
    return temperature_c, humidity_pct, co2_ppm


def get_required_env(name: str) -> str:
    """必須の環境変数を取得する。

    Args:
        name: 環境変数名。

    Returns:
        環境変数の値。

    Raises:
        RuntimeError: 環境変数が未設定または空の場合。
    """
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"環境変数 '{name}' は必須です。")
    return value


async def scan_once_for_reading(mac_address: str, timeout_s: float) -> Optional[Reading]:
    """一定時間BLEスキャンし、対象デバイスの計測値を1件返す。

    Args:
        mac_address: 対象BLE MACアドレス。
        timeout_s: スキャンタイムアウト秒。

    Returns:
        取得できた場合はReading、取得できない場合はNone。
    """
    discovered = await BleakScanner.discover(timeout=timeout_s, return_adv=True)
    target = mac_address.upper()

    for address, (_, advertisement_data) in discovered.items():
        if address.upper() != target:
            continue

        mfg_data = advertisement_data.manufacturer_data.get(COMPANY_ID)
        if not mfg_data:
            continue

        temperature_c, humidity_pct, co2_ppm = parse_switchbot_data(mfg_data)
        return Reading(
            timestamp=datetime.now().astimezone().isoformat(timespec="seconds"),
            temperature_c=round(temperature_c, 1),
            humidity_pct=humidity_pct,
            co2_ppm=co2_ppm,
            device_mac=target,
        )

    return None


def post_to_gas_blocking(
    reading: Reading,
    gas_post_url: str,
    gas_post_token: str,
    timeout_s: float,
) -> dict:
    """1件の計測値をJSONボディとしてGASへPOSTする。

    Args:
        reading: 送信する計測値。
        gas_post_url: GAS WebアプリのエンドポイントURL。
        gas_post_token: JSONボディに含める共有トークン。
        timeout_s: HTTPタイムアウト秒。

    Returns:
        JSONとして解釈したレスポンス。JSONでない場合は生レスポンス文字列を含む辞書。
    """
    payload = {"token": gas_post_token, **asdict(reading)}
    body = json.dumps(payload).encode("utf-8")

    request = Request(
        url=gas_post_url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )

    with urlopen(request, timeout=timeout_s) as response:
        response_text = response.read().decode("utf-8")
        try:
            return json.loads(response_text)
        except json.JSONDecodeError:
            return {"ok": True, "raw_response": response_text}


async def post_to_gas(
    reading: Reading,
    gas_post_url: str,
    gas_post_token: str,
    timeout_s: float,
) -> dict:
    """同期HTTP送信処理の非同期ラッパー。"""
    return await asyncio.to_thread(
        post_to_gas_blocking,
        reading,
        gas_post_url,
        gas_post_token,
        timeout_s,
    )


async def run_collector_loop() -> None:
    """収集処理を常駐実行する（取得→送信→待機を繰り返す）。"""
    target_mac = get_required_env("CO2_METER_BLE_MAC_ADDRESS")
    gas_post_url = get_required_env("GAS_POST_URL")
    gas_post_token = get_required_env("GAS_POST_TOKEN")

    poll_interval_s = int(os.getenv("POLL_INTERVAL_SECONDS", "300"))
    scan_timeout_s = float(os.getenv("SCAN_TIMEOUT_SECONDS", "12"))
    http_timeout_s = float(os.getenv("HTTP_TIMEOUT_SECONDS", "15"))
    post_retry_count = int(os.getenv("POST_RETRY_COUNT", "3"))

    print("収集処理を開始しました。終了するには Ctrl+C を押してください。")
    print(f"対象MACアドレス: {target_mac}")
    print(f"収集間隔: {poll_interval_s}秒")

    while True:
        cycle_start = asyncio.get_running_loop().time()
        try:
            reading = await scan_once_for_reading(target_mac, scan_timeout_s)
            if reading is None:
                print("このサイクルでは計測値を取得できませんでした。")
            else:
                print(
                    f"[{reading.timestamp}] 温度={reading.temperature_c:.1f}ºC "
                    f"湿度={reading.humidity_pct}% CO2={reading.co2_ppm}ppm"
                )

                # 一時的なネットワーク障害を吸収するため、送信はリトライする。
                last_error: Optional[Exception] = None
                for attempt in range(1, post_retry_count + 1):
                    try:
                        response = await post_to_gas(
                            reading,
                            gas_post_url,
                            gas_post_token,
                            http_timeout_s,
                        )
                        print(f"POST成功 (試行 {attempt} 回目): {response}")
                        last_error = None
                        break
                    except (HTTPError, URLError, TimeoutError, OSError) as exc:
                        last_error = exc
                        print(f"POST失敗 (試行 {attempt} 回目): {exc}")
                        if attempt < post_retry_count:
                            await asyncio.sleep(min(2 * attempt, 5))

                if last_error is not None:
                    print(f"{post_retry_count}回の試行後もPOSTに失敗しました: {last_error}")
        except Exception as exc:
            # プロセスは継続し、次サイクルで自動復旧を試みる。
            print(f"収集ループで予期しないエラーが発生しました: {exc}")

        elapsed = asyncio.get_running_loop().time() - cycle_start
        await asyncio.sleep(max(0, poll_interval_s - elapsed))


if __name__ == "__main__":
    asyncio.run(run_collector_loop())
