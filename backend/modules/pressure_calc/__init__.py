"""气压计算模块。

根据气球传回的零散气压、温度数据，用流体力学公式反推高度与风速。

子模块:
- constants: 国际标准大气物理常数
- atmosphere: 标准大气压高公式、空气密度
- interpolation: 散点数据清洗与插值
- wind: 由气压梯度计算地转风
- calculator: 组合上述能力的高层接口
"""
from __future__ import annotations

from modules.pressure_calc.calculator import PressureCalculator

__all__ = ["PressureCalculator"]
