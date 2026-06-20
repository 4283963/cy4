"""气球相关 API 路由。

提供:
    POST /api/balloons/{balloon_id}/readings   - 上传原始读数
    POST /api/balloons/{balloon_id}/compute    - 反演高度与风场
    POST /api/balloons/{balloon_id}/predict    - 推演落点轨迹
    GET  /api/balloons/simulate                - 一键生成演示数据(反演+推演)
    GET  /api/balloons/                        - 列出所有已注册气球
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from models.schemas import (
    BalloonReading,
    ComputeResponse,
    PredictRequest,
    PredictResponse,
    SimulateResponse,
)
from services import balloon_service

router = APIRouter(prefix="/balloons", tags=["balloons"])


@router.get("/")
def list_balloons():
    """返回所有已注册气球的概要信息。"""
    return {"balloons": balloon_service.list_balloons()}


@router.post("/{balloon_id}/readings")
def upload_readings(balloon_id: str, readings: list[BalloonReading]):
    """为指定气球追加一批原始散点读数。"""
    if not readings:
        raise HTTPException(status_code=400, detail="请提供至少一条读数。")
    added = balloon_service.add_readings(balloon_id, readings)
    return {"balloon_id": balloon_id, "added": added, "total": added}


@router.post("/{balloon_id}/compute")
def compute_atmosphere(balloon_id: str, readings: list[BalloonReading] | None = None) -> ComputeResponse:
    """对指定气球执行气压反演，返回逐点大气状态（高度、密度、风场等）。

    若在请求体中提供 readings，则直接使用；否则使用该气球已上传的历史读数。
    """
    bid, states = balloon_service.compute_states(balloon_id, readings)
    if not states:
        raise HTTPException(status_code=400, detail="无可反演的数据。")
    return ComputeResponse(
        balloon_id=bid,
        states=states,
        reading_count=len(states),
    )


@router.post("/{balloon_id}/predict")
def predict_trajectory(balloon_id: str, req: PredictRequest) -> PredictResponse:
    """推演气球后续飞行轨迹与落点。

    request 中可附带 readings 让服务端先做反演得到风廓线，再进行推演；
    也可显式指定 wind_profile 数组（每项含 alt/u/v）。
    """
    req.balloon_id = balloon_id
    traj, landing, _ = balloon_service.predict_trajectory(req)
    return PredictResponse(balloon_id=balloon_id, trajectory=traj, landing=landing)


@router.get("/simulate")
def simulate_balloon(seed: int = Query(42, ge=0, le=99999)) -> SimulateResponse:
    """一键生成演示数据：内部生成逼真读数 → 反演 → 推演，直接返回完整结果。

    前端在无真实数据时可直接调用此接口，立刻获得一段完整的飞行历史 + 预测轨迹。
    seed 参数可控制生成不同的随机飞行场景。
    """
    bid, readings, meta = balloon_service.generate_demo_readings(seed=seed)

    _, states = balloon_service.compute_states(bid, readings)
    if not states:
        raise HTTPException(status_code=500, detail="生成数据反演失败。")

    # 用最后一个反演状态作为推演初值
    last = states[-1]
    if last.lat is None or last.lon is None:
        raise HTTPException(status_code=500, detail="演示数据缺少位置信息。")

    req = PredictRequest(
        balloon_id=bid,
        initial_lat=last.lat,
        initial_lon=last.lon,
        initial_alt=last.altitude_m,
        initial_phase="ascent" if last.ascent_rate_mps > 0 else "descent",
        readings=None,
        dt_sec=30.0,
        max_steps=2000,
    )
    traj, landing, _ = balloon_service.predict_trajectory(req)

    return SimulateResponse(
        balloon_id=bid,
        states=states,
        predicted_trajectory=traj,
        landing=landing,
    )
