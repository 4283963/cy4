"""国际标准大气(ISA)物理常数与大气分层定义。

所有气压以帕斯卡(Pa)、温度以开尔文(K)、高度以米(m)为内部单位，
遵循流体力学中常用的一致 SI 量纲。
"""
from __future__ import annotations

# --- 基本物理常数 ---
GRAVITY: float = 9.80665            # 重力加速度 (m/s^2)
GAS_CONSTANT: float = 8.31446       # 通用气体常数 (J/(mol·K))
MOLAR_MASS_AIR: float = 0.0289644   # 干空气摩尔质量 (kg/mol)
R_D: float = GAS_CONSTANT / MOLAR_MASS_AIR  # 干空气比气体常数 ≈ 287.053 J/(kg·K)
GAMMA: float = 1.4                  # 空气比热比

EARTH_OMEGA: float = 7.2921e-5      # 地球自转角速度 (rad/s)
EARTH_RADIUS: float = 6_371_000.0   # 地球平均半径 (m)
DEG_TO_M_LAT: float = EARTH_RADIUS * 3.141592653589793 / 180.0  # 1°纬度对应的米数

# --- 海平面标准值 ---
P0: float = 101325.0                # 海平面标准气压 (Pa) = 1013.25 hPa
T0: float = 288.15                  # 海平面标准温度 (K) = 15°C

# --- ISA 大气分层 ---
# 每层: (底高度 m, 底温度 K, 底气压 Pa, 温度直减率 K/m)
#   直减率为负 -> 温度随高度递减 (对流层)
#   直减率为零 -> 等温层 (平流层下部)
#   直减率为正 -> 逆温层 (平流层上部)
# 这些底值取自 U.S. Standard Atmosphere 1976。
ISA_LAYERS: list[tuple[float, float, float, float]] = [
    (0.0,     288.15, 101325.0, -0.0065),
    (11000.0, 216.65, 22632.0,  0.0),
    (20000.0, 216.65, 5474.9,   0.0010),
    (32000.0, 228.65, 868.02,   0.0028),
]
