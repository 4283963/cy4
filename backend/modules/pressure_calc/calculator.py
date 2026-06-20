"""气压计算模块高层接口：散点气压/温度数据 -> 高度/密度/风场。

工作流程：
1. 清洗：丢弃关键字段缺失的读数，按时间排序，对相同时间戳取均值。
2. 平滑：对气压、温度序列去噪，抑制测量随机误差。
3. 反演高度：逐点用压高公式由气压反推几何高度。
4. 密度：理想气体状态方程由气压、温度得到空气密度。
5. 上升率：对高度序列求时间导数 dh/dt。
6. 风场：将经纬度转局地坐标，局部拟合气压梯度，代入地转风关系。

输入读数为类字典对象，需含 timestamp/pressure_hpa/temperature_c，
lat/lon 可选(缺失时风场为零)。
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from modules.pressure_calc import atmosphere, constants as C
from modules.pressure_calc.interpolation import (
    smooth_series,
    time_derivative,
    to_float,
)
from modules.pressure_calc.wind import (
    geostrophic_wind,
    latlon_to_xy,
    local_pressure_gradient,
)

_REQUIRED = ("timestamp", "pressure_hpa", "temperature_c")


class PressureCalculator:
    """对零散探空读数执行流体力学反演。"""

    def compute(self, readings: list[Any]) -> list[dict]:
        if not readings:
            return []

        recs: list[dict] = []
        for raw in readings:
            r = {
                "t": to_float(raw.get("timestamp")),
                "p": to_float(raw.get("pressure_hpa")),
                "tc": to_float(raw.get("temperature_c")),
                "lat": to_float(raw.get("lat")),
                "lon": to_float(raw.get("lon")),
            }
            if not all(math.isfinite(r[k]) for k in ("t", "p", "tc")):
                continue
            recs.append(r)

        if not recs:
            return []

        recs.sort(key=lambda r: r["t"])

        # 相同时间戳取均值(去重)
        grouped: dict[float, list[dict]] = {}
        for r in recs:
            grouped.setdefault(r["t"], []).append(r)
        recs = []
        for t, group in grouped.items():
            n = len(group)
            recs.append({
                "t": t,
                "p": sum(g["p"] for g in group) / n,
                "tc": sum(g["tc"] for g in group) / n,
                "lat": float(np.nanmean([g["lat"] for g in group])),
                "lon": float(np.nanmean([g["lon"] for g in group])),
            })

        t = np.array([r["t"] for r in recs], dtype=float)
        p_hpa = np.array([r["p"] for r in recs], dtype=float)
        tc = np.array([r["tc"] for r in recs], dtype=float)
        lats = np.array([r["lat"] for r in recs], dtype=float)
        lons = np.array([r["lon"] for r in recs], dtype=float)

        # 平滑去噪
        p_sm = smooth_series(p_hpa)
        tc_sm = smooth_series(tc)

        # SI 单位转换
        p_pa = p_sm * 100.0
        t_k = tc_sm + 273.15

        # 逐点反演高度与密度
        alt = np.array([atmosphere.altitude_from_pressure(float(pp)) for pp in p_pa])
        dens = np.array([atmosphere.air_density(float(pp), float(tk))
                         for pp, tk in zip(p_pa, t_k)])
        sound = np.array([atmosphere.speed_of_sound(float(tk)) for tk in t_k])

        # 上升率 dh/dt
        ascent = time_derivative(t, alt)

        # 风场：需要经纬度且样本足够
        has_pos = bool(np.all(np.isfinite(lats)) and np.all(np.isfinite(lons)) and lats.size >= 3)
        if has_pos:
            lat0 = float(np.mean(lats))
            lon0 = float(np.mean(lons))
            x, y = latlon_to_xy(lats, lons, lat0, lon0)
            dPdx, dPdy = local_pressure_gradient(x, y, p_pa)
            winds = [geostrophic_wind(float(dPdx[i]), float(dPdy[i]),
                                      float(dens[i]), lat0)
                     for i in range(len(recs))]
        else:
            winds = [(0.0, 0.0, 0.0, 0.0)] * len(recs)

        states: list[dict] = []
        for i in range(len(recs)):
            u, v, speed, direction = winds[i]
            states.append({
                "timestamp": float(t[i]),
                "altitude_m": float(alt[i]),
                "pressure_hpa": float(p_sm[i]),
                "temperature_c": float(tc_sm[i]),
                "temperature_k": float(t_k[i]),
                "density_kg_m3": float(dens[i]),
                "sound_speed_mps": float(sound[i]),
                "ascent_rate_mps": float(ascent[i]),
                "wind_u_mps": float(u),
                "wind_v_mps": float(v),
                "wind_speed_mps": float(speed),
                "wind_direction_deg": float(direction),
                "lat": float(lats[i]) if math.isfinite(lats[i]) else None,
                "lon": float(lons[i]) if math.isfinite(lons[i]) else None,
            })
        return states
