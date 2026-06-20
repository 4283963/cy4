"""散点气象数据清洗、平滑与时间序列插值。

探空气球传回的气压/温度数据通常是「零散」的：采样间隔不规则、
含有测量噪声、可能缺失部分字段。本模块负责将其规整为可用的时间序列。
仅依赖 numpy，避免引入重型科学计算库。
"""
from __future__ import annotations

import math

import numpy as np


def to_float(value, default: float = float("nan")) -> float:
    """安全转换为 float，失败返回 default。"""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def smooth_series(values, window: int = 7) -> np.ndarray:
    """中心化滑动平均去噪，边界自动缩窗。

    相比逐点原值，平滑能抑制气压/温度的随机测量噪声，
    使后续高度反演与导数计算更稳定。
    """
    v = np.asarray(values, dtype=float)
    n = v.size
    if n == 0:
        return v
    half = max(1, min(window, n) // 2)
    out = np.empty(n)
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        out[i] = float(np.mean(v[lo:hi]))
    return out


def time_derivative(times, values) -> np.ndarray:
    """数值时间导数 dv/dt，内部使用中心差分、边界单侧差分。"""
    t = np.asarray(times, dtype=float)
    v = np.asarray(values, dtype=float)
    n = v.size
    dvdt = np.zeros(n)
    if n >= 2:
        dvdt[1:-1] = (v[2:] - v[:-2]) / (t[2:] - t[:-2])
        dvdt[0] = (v[1] - v[0]) / (t[1] - t[0])
        dvdt[-1] = (v[-1] - v[-2]) / (t[-1] - t[-2])
    return dvdt


def resample_regular(times, values, dt: float = 1.0):
    """将不规则时间序列重采样为等间距 dt 的序列(线性插值)。"""
    t = np.asarray(times, dtype=float)
    v = np.asarray(values, dtype=float)
    if t.size < 2:
        return t.copy(), v.copy()
    n = max(2, int(math.ceil((t[-1] - t[0]) / dt)) + 1)
    t_reg = np.linspace(t[0], t[-1], n)
    v_reg = np.interp(t_reg, t, v)
    return t_reg, v_reg
