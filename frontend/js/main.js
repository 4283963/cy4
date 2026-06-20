/**
 * 探空气球三维轨迹可视化 - 核心逻辑
 *
 * 坐标系统:
 *   - 经纬度 + 高度 → 球心在原点的三维球面坐标
 *   - 地球半径 EARTH_R = 100 单位 (缩放以便视觉呈现)
 *   - 海拔从地面向外径向延伸
 *   - Y轴向上 (北极方向)
 *
 * 数据流:
 *   GET /api/balloons/simulate → SimulateResponse
 *     → states[] (历史航迹)
 *     → predicted_trajectory[] (预测航迹)
 *     → landing (落点)
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- 常量 ---
const EARTH_R = 100;
const ALT_SCALE = 0.0015;  // 米 → 三维单位的缩放系数 (30km ≈ 45 单位)
const API_BASE = window.location.origin.includes('localhost') || window.location.protocol === 'file:'
    ? 'http://localhost:8000/api'
    : '/api';

// --- Three.js 基础对象 ---
let scene, camera, renderer, controls;
let clock = new THREE.Clock();

// --- 场景元素 ---
let earthGroup, atmosphereGroup;
let historyLine, predictedLine;
let balloonMesh, balloonTrail;
let burstMarker, landingMarker;
let stars;

// --- 数据状态 ---
let currentData = null;
let animationProgress = 0;
let isAnimating = true;
let autoRotate = true;
let animationSpeed = 0.15;

// --- DOM 元素 ---
const dom = {
    hudBalloonId: document.getElementById('hud-balloon-id'),
    hudAlt: document.getElementById('hud-alt'),
    hudPressure: document.getElementById('hud-pressure'),
    hudTemp: document.getElementById('hud-temp'),
    hudWind: document.getElementById('hud-wind'),
    hudDir: document.getElementById('hud-dir'),
    hudAscent: document.getElementById('hud-ascent'),
    hudTime: document.getElementById('hud-time'),
    hudLanding: document.getElementById('hud-landing'),
    landLat: document.getElementById('land-lat'),
    landLon: document.getElementById('land-lon'),
    landTime: document.getElementById('land-time'),
    btnLoad: document.getElementById('btn-load'),
    btnReload: document.getElementById('btn-reload'),
    seedInput: document.getElementById('seed-input'),
    toggleRotate: document.getElementById('toggle-auto-rotate'),
    toggleAnimate: document.getElementById('toggle-animate'),
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    loading: document.getElementById('loading'),
    sceneContainer: document.getElementById('scene-container'),
};

// ============================================================================
// 初始化 Three.js 场景
// ============================================================================

function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x030712);
    scene.fog = new THREE.FogExp2(0x030712, 0.002);

    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 5000);
    camera.position.set(0, 120, 280);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    dom.sceneContainer.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 130;
    controls.maxDistance = 800;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;

    window.addEventListener('resize', onWindowResize);
}

function initLights() {
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(200, 150, 100);
    sun.castShadow = false;
    scene.add(sun);

    const fill = new THREE.DirectionalLight(0x38bdf8, 0.4);
    fill.position.set(-150, 50, -100);
    scene.add(fill);

    const rim = new THREE.PointLight(0xa78bfa, 1.5, 500);
    rim.position.set(-100, -50, 200);
    scene.add(rim);
}

function initStars() {
    const starGeometry = new THREE.BufferGeometry();
    const starCount = 4000;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount; i++) {
        const r = 1500 + Math.random() * 1000;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.cos(phi);
        positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

        const starColor = new THREE.Color();
        starColor.setHSL(0.55 + Math.random() * 0.15, 0.3 + Math.random() * 0.4, 0.6 + Math.random() * 0.4);
        colors[i * 3] = starColor.r;
        colors[i * 3 + 1] = starColor.g;
        colors[i * 3 + 2] = starColor.b;
    }

    starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const starMaterial = new THREE.PointsMaterial({
        size: 1.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        sizeAttenuation: true,
    });

    stars = new THREE.Points(starGeometry, starMaterial);
    scene.add(stars);
}

function initEarth() {
    earthGroup = new THREE.Group();
    scene.add(earthGroup);

    // 地球主体 - 深蓝渐变
    const earthGeo = new THREE.SphereGeometry(EARTH_R, 96, 96);
    const earthMat = new THREE.ShaderMaterial({
        uniforms: {
            uColor1: { value: new THREE.Color(0x0f172a) },
            uColor2: { value: new THREE.Color(0x1e3a5f) },
            uGlowColor: { value: new THREE.Color(0x38bdf8) },
        },
        vertexShader: `
            varying vec3 vNormal;
            varying vec3 vPosition;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                vPosition = position;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            varying vec3 vNormal;
            varying vec3 vPosition;
            uniform vec3 uColor1;
            uniform vec3 uColor2;
            uniform vec3 uGlowColor;
            void main() {
                float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
                float lat = vPosition.y / 100.0;
                vec3 base = mix(uColor1, uColor2, lat * 0.5 + 0.5);
                vec3 glow = uGlowColor * intensity * 0.8;
                gl_FragColor = vec4(base + glow, 1.0);
            }
        `,
    });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    earthGroup.add(earth);

    // 大气辉光 - 外层半透明球
    const atmosphereGeo = new THREE.SphereGeometry(EARTH_R * 1.08, 64, 64);
    const atmosphereMat = new THREE.ShaderMaterial({
        uniforms: {
            uGlowColor: { value: new THREE.Color(0x38bdf8) },
        },
        vertexShader: `
            varying vec3 vNormal;
            void main() {
                vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            varying vec3 vNormal;
            uniform vec3 uGlowColor;
            void main() {
                float intensity = pow(0.8 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);
                gl_FragColor = vec4(uGlowColor, intensity * 0.5);
            }
        `,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
    });
    const atmosphere = new THREE.Mesh(atmosphereGeo, atmosphereMat);
    earthGroup.add(atmosphere);

    // 经线 (12条)
    const meridiansGroup = new THREE.Group();
    for (let lon = 0; lon < 12; lon++) {
        const points = [];
        const angle = (lon / 12) * Math.PI * 2;
        for (let lat = -90; lat <= 90; lat += 2) {
            const latRad = (lat * Math.PI) / 180;
            points.push(new THREE.Vector3(
                EARTH_R * Math.cos(latRad) * Math.cos(angle),
                EARTH_R * Math.sin(latRad),
                EARTH_R * Math.cos(latRad) * Math.sin(angle)
            ));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0x334155,
            transparent: true,
            opacity: 0.35,
        });
        meridiansGroup.add(new THREE.Line(geo, mat));
    }
    earthGroup.add(meridiansGroup);

    // 纬线 (8条)
    const parallelsGroup = new THREE.Group();
    for (let latIdx = 0; latIdx < 9; latIdx++) {
        const lat = -80 + latIdx * 20;
        if (Math.abs(lat) >= 90) continue;
        const latRad = (lat * Math.PI) / 180;
        const r = EARTH_R * Math.cos(latRad);
        const y = EARTH_R * Math.sin(latRad);
        const points = [];
        for (let a = 0; a <= 360; a += 3) {
            const ar = (a * Math.PI) / 180;
            points.push(new THREE.Vector3(r * Math.cos(ar), y, r * Math.sin(ar)));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({
            color: 0x334155,
            transparent: true,
            opacity: 0.35,
        });
        parallelsGroup.add(new THREE.Line(geo, mat));
    }
    earthGroup.add(parallelsGroup);

    // 赤道线 (高亮)
    const equatorPoints = [];
    for (let a = 0; a <= 360; a += 2) {
        const ar = (a * Math.PI) / 180;
        equatorPoints.push(new THREE.Vector3(EARTH_R * Math.cos(ar), 0, EARTH_R * Math.sin(ar)));
    }
    const equatorGeo = new THREE.BufferGeometry().setFromPoints(equatorPoints);
    const equatorMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.4,
    });
    earthGroup.add(new THREE.Line(equatorGeo, equatorMat));
}

// ============================================================================
// 坐标转换: (lat, lon, alt) → THREE.Vector3
// ============================================================================

function latLonAltToVec3(lat, lon, alt) {
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    const r = EARTH_R + alt * ALT_SCALE;
    return new THREE.Vector3(
        r * Math.cos(latRad) * Math.cos(lonRad),
        r * Math.sin(latRad),
        r * Math.cos(latRad) * Math.sin(lonRad)
    );
}

// ============================================================================
// 创建轨迹线
// ============================================================================

function createTrajectoryLine(points, color, dashed = false) {
    if (!points || points.length < 2) return null;

    const geo = new THREE.BufferGeometry().setFromPoints(points);

    let mat;
    if (dashed) {
        mat = new THREE.LineDashedMaterial({
            color: color,
            linewidth: 2,
            dashSize: 3,
            gapSize: 2,
            transparent: true,
            opacity: 0.85,
        });
    } else {
        mat = new THREE.LineBasicMaterial({
            color: color,
            linewidth: 2.5,
            transparent: true,
            opacity: 0.95,
        });
    }

    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();

    // 添加发光效果
    const glowMat = new THREE.LineBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.25,
        linewidth: 8,
    });
    const glowLine = new THREE.Line(geo, glowMat);

    const group = new THREE.Group();
    group.add(glowLine);
    group.add(line);
    return group;
}

function createBalloon() {
    const group = new THREE.Group();

    // 气球本体 - 半透明橙色球体
    const balloonGeo = new THREE.SphereGeometry(3.5, 32, 32);
    const balloonMat = new THREE.MeshPhongMaterial({
        color: 0xfb923c,
        emissive: 0xfb923c,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.85,
        shininess: 100,
    });
    const balloon = new THREE.Mesh(balloonGeo, balloonMat);
    group.add(balloon);

    // 气球辉光
    const glowGeo = new THREE.SphereGeometry(4.5, 32, 32);
    const glowMat = new THREE.MeshBasicMaterial({
        color: 0xfb923c,
        transparent: true,
        opacity: 0.25,
        side: THREE.BackSide,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    group.add(glow);

    // 牵引线
    const trailPoints = [
        new THREE.Vector3(0, -3.5, 0),
        new THREE.Vector3(0, -7, 0),
    ];
    const trailGeo = new THREE.BufferGeometry().setFromPoints(trailPoints);
    const trailMat = new THREE.LineBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.6,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    group.add(trail);

    // 载荷盒
    const payloadGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    const payloadMat = new THREE.MeshPhongMaterial({
        color: 0x94a3b8,
        emissive: 0x38bdf8,
        emissiveIntensity: 0.2,
    });
    const payload = new THREE.Mesh(payloadGeo, payloadMat);
    payload.position.y = -7.5;
    group.add(payload);

    // 指向灯
    const light = new THREE.PointLight(0xfb923c, 1, 40);
    group.add(light);

    return group;
}

function createMarker(color, size = 4) {
    const group = new THREE.Group();

    // 核心点
    const coreGeo = new THREE.SphereGeometry(size * 0.5, 16, 16);
    const coreMat = new THREE.MeshBasicMaterial({ color: color });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    // 外圈脉冲环
    const ringGeo = new THREE.RingGeometry(size * 0.8, size, 32);
    const ringMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.userData.isRing = true;
    group.add(ring);

    // 外层辉光
    const glowGeo = new THREE.SphereGeometry(size * 1.5, 32, 32);
    const glowMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.2,
        side: THREE.BackSide,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.userData.isGlow = true;
    group.add(glow);

    // 光束
    const beamGeo = new THREE.ConeGeometry(size * 0.5, size * 4, 16, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.rotation.x = Math.PI / 2;
    beam.position.z = size * 2;
    beam.userData.isBeam = true;
    group.add(beam);

    return group;
}

// ============================================================================
// 数据加载与场景构建
// ============================================================================

async function loadData(seed) {
    setStatus('loading', `正在获取种子 ${seed} 的探空数据...`);
    showLoading(true);

    try {
        const response = await fetch(`${API_BASE}/balloons/simulate?seed=${seed}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        currentData = data;
        buildScene(data);
        setStatus('ready', `数据就绪 · 气球 ${data.balloon_id}`);
        return data;
    } catch (err) {
        console.error('加载数据失败:', err);
        setStatus('error', `加载失败: ${err.message}`);
        // 回退到示例数据
        console.warn('使用回退示例数据');
        const fallback = generateFallbackData(seed);
        currentData = fallback;
        buildScene(fallback);
        setStatus('ready', `示例数据 · 气球 ${fallback.balloon_id}`);
        return fallback;
    } finally {
        showLoading(false);
    }
}

function generateFallbackData(seed) {
    // 生成一段示例数据用于脱机演示
    const rng = mulberry32(seed);
    const states = [];
    let lat = 39.9042, lon = 116.4074;
    const totalTime = 3600;

    for (let t = 0; t < totalTime; t += 15) {
        const alt = t * 5;
        const p_hpa = 1013 * Math.exp(-alt / 8500) + rng() * 0.5;
        const temp = 15 - 0.0065 * alt + rng() * 0.3;
        const windSpeed = 15 + alt / 1000 * 2;
        const windDir = 270 + rng() * 20;
        lat += (windSpeed * Math.sin(windDir * Math.PI / 180) / 6371000) * (180 / Math.PI) * 15;
        lon += (windSpeed * Math.cos(windDir * Math.PI / 180) / (6371000 * Math.cos(lat * Math.PI / 180))) * (180 / Math.PI) * 15;

        states.push({
            timestamp: t,
            altitude_m: alt,
            pressure_hpa: p_hpa,
            temperature_c: temp,
            temperature_k: temp + 273.15,
            density_kg_m3: p_hpa * 100 / (287 * (temp + 273.15)),
            sound_speed_mps: Math.sqrt(1.4 * 287 * (temp + 273.15)),
            ascent_rate_mps: 5,
            wind: {
                u_mps: windSpeed * Math.sin(windDir * Math.PI / 180),
                v_mps: windSpeed * Math.cos(windDir * Math.PI / 180),
                speed_mps: windSpeed,
                direction_deg: windDir,
            },
            lat: lat,
            lon: lon,
        });
        if (alt >= 30000) break;
    }

    // 预测轨迹
    const predicted = [];
    let plat = lat, plon = lon, palt = 30000;
    for (let t = 0; t < 4000; t += 30) {
        const windSpeed = 30;
        const windDir = 260;
        plat += (windSpeed * Math.sin(windDir * Math.PI / 180) / 6371000) * (180 / Math.PI) * 30;
        plon += (windSpeed * Math.cos(windDir * Math.PI / 180) / (6371000 * Math.cos(plat * Math.PI / 180))) * (180 / Math.PI) * 30;
        palt = Math.max(0, 30000 - t * 6);
        predicted.push({
            t_sec: t,
            lat: plat,
            lon: plon,
            alt: palt,
            phase: palt > 0 ? 'descent' : 'landed',
            wind_u: windSpeed * Math.sin(windDir * Math.PI / 180),
            wind_v: windSpeed * Math.cos(windDir * Math.PI / 180),
        });
        if (palt <= 0) break;
    }

    return {
        balloon_id: `demo-${seed}`,
        states: states,
        predicted_trajectory: predicted,
        landing: {
            lat: plat,
            lon: plon,
            alt: 0,
            flight_time_sec: predicted.length * 30,
        },
    };
}

function mulberry32(a) {
    return function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = a;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function buildScene(data) {
    clearScene();

    // 构建历史航迹点
    const historyPoints = data.states
        .filter(s => s.lat != null && s.lon != null)
        .map(s => latLonAltToVec3(s.lat, s.lon, s.altitude_m));

    if (historyPoints.length >= 2) {
        historyLine = createTrajectoryLine(historyPoints, 0xfb923c, false);
        scene.add(historyLine);
    }

    // 构建预测航迹点
    const predictPoints = data.predicted_trajectory
        .map(p => latLonAltToVec3(p.lat, p.lon, p.alt));

    if (predictPoints.length >= 2) {
        predictedLine = createTrajectoryLine(predictPoints, 0x38bdf8, true);
        scene.add(predictedLine);
    }

    // 创建气球
    balloonMesh = createBalloon();
    balloonMesh.position.copy(historyPoints[0] || predictPoints[0]);
    scene.add(balloonMesh);

    // 爆裂点标记 (历史轨迹最高点)
    let maxAlt = -1, maxIdx = 0;
    data.states.forEach((s, i) => {
        if (s.altitude_m > maxAlt) {
            maxAlt = s.altitude_m;
            maxIdx = i;
        }
    });
    if (historyPoints[maxIdx]) {
        burstMarker = createMarker(0xf87171, 4.5);
        burstMarker.position.copy(historyPoints[maxIdx]);
        // 使标记环始终面向相机
        burstMarker.userData.billboard = true;
        scene.add(burstMarker);
    }

    // 落点标记
    if (data.landing) {
        landingMarker = createMarker(0x4ade80, 5);
        const landingPos = latLonAltToVec3(data.landing.lat, data.landing.lon, 0);
        landingMarker.position.copy(landingPos);
        landingMarker.userData.billboard = true;
        scene.add(landingMarker);

        // 更新落点HUD
        dom.hudLanding.classList.add('visible');
        dom.landLat.textContent = data.landing.lat.toFixed(4) + '°';
        dom.landLon.textContent = data.landing.lon.toFixed(4) + '°';
        const ft = data.landing.flight_time_sec;
        dom.landTime.textContent = `${Math.floor(ft / 60)}分${Math.floor(ft % 60)}秒`;
    }

    // 更新气球ID
    dom.hudBalloonId.textContent = data.balloon_id;

    // 重置动画
    animationProgress = 0;

    // 相机定位到发射点上方
    if (historyPoints.length > 0) {
        const start = historyPoints[0];
        const offset = new THREE.Vector3(80, 60, 80);
        camera.position.copy(start).add(offset);
        controls.target.copy(start);
        controls.update();
    }
}

function clearScene() {
    [historyLine, predictedLine, balloonMesh, burstMarker, landingMarker].forEach(obj => {
        if (obj) {
            scene.remove(obj);
            if (obj.traverse) {
                obj.traverse(child => {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => m.dispose());
                        } else {
                            child.material.dispose();
                        }
                    }
                });
            }
        }
    });
    historyLine = null;
    predictedLine = null;
    balloonMesh = null;
    burstMarker = null;
    landingMarker = null;
    dom.hudLanding.classList.remove('visible');
}

// ============================================================================
// 动画系统
// ============================================================================

function interpolateOnPath(points, progress) {
    if (!points || points.length < 2) return points?.[0] || new THREE.Vector3();

    // progress 0~1 映射到整条路径
    const totalSegments = points.length - 1;
    const exact = progress * totalSegments;
    const idx = Math.min(Math.floor(exact), totalSegments - 1);
    const frac = exact - idx;

    const p0 = points[idx];
    const p1 = points[idx + 1];
    return new THREE.Vector3().lerpVectors(p0, p1, frac);
}

function getStateAtProgress(data, progress) {
    const allStates = data.states;
    if (!allStates || allStates.length === 0) return null;

    const total = allStates.length - 1;
    const exact = progress * total;
    const idx = Math.min(Math.floor(exact), total - 1);
    const frac = exact - idx;

    if (idx < 0 || idx + 1 >= allStates.length) return allStates[Math.min(idx, allStates.length - 1)];

    const s0 = allStates[idx];
    const s1 = allStates[idx + 1];

    return {
        timestamp: lerp(s0.timestamp, s1.timestamp, frac),
        altitude_m: lerp(s0.altitude_m, s1.altitude_m, frac),
        pressure_hpa: lerp(s0.pressure_hpa, s1.pressure_hpa, frac),
        temperature_c: lerp(s0.temperature_c, s1.temperature_c, frac),
        wind_speed_mps: lerp(s0.wind.speed_mps, s1.wind.speed_mps, frac),
        wind_direction_deg: lerp(s0.wind.direction_deg, s1.wind.direction_deg, frac),
        ascent_rate_mps: lerp(s0.ascent_rate_mps, s1.ascent_rate_mps, frac),
    };
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function updateHUD(state) {
    if (!state) return;
    dom.hudAlt.textContent = Math.round(state.altitude_m).toLocaleString();
    dom.hudPressure.textContent = state.pressure_hpa.toFixed(1);
    dom.hudTemp.textContent = state.temperature_c.toFixed(1);
    dom.hudWind.textContent = state.wind_speed_mps.toFixed(1);
    dom.hudDir.textContent = Math.round(state.wind_direction_deg);
    dom.hudAscent.textContent = state.ascent_rate_mps.toFixed(2);
    dom.hudTime.textContent = Math.round(state.timestamp).toLocaleString();
}

function updateAnimation(delta) {
    if (!currentData || !isAnimating) return;

    animationProgress += delta * animationSpeed;
    if (animationProgress > 1) animationProgress = 0;

    // 构建完整路径（历史 + 预测）
    const historyPoints = currentData.states
        .filter(s => s.lat != null && s.lon != null)
        .map(s => latLonAltToVec3(s.lat, s.lon, s.altitude_m));
    const predictPoints = currentData.predicted_trajectory
        .map(p => latLonAltToVec3(p.lat, p.lon, p.alt));

    const allPoints = [...historyPoints, ...predictPoints];
    const pos = interpolateOnPath(allPoints, animationProgress);

    if (balloonMesh) {
        balloonMesh.position.copy(pos);
        balloonMesh.rotation.y += delta * 0.5;

        // 气球漂浮效果
        const float = Math.sin(clock.elapsedTime * 2) * 0.5;
        balloonMesh.children[0].position.y = float;
    }

    // 更新HUD
    const historyProgress = Math.min(1, animationProgress * allPoints.length / historyPoints.length);
    if (historyProgress < 1) {
        const state = getStateAtProgress(currentData, historyProgress);
        if (state) updateHUD(state);
    } else if (currentData.predicted_trajectory.length > 0) {
        // 预测阶段，显示预测的风场信息
        const predictProgress = Math.min(1, (animationProgress * allPoints.length - historyPoints.length) / predictPoints.length);
        const ptIdx = Math.floor(predictProgress * (currentData.predicted_trajectory.length - 1));
        const pt = currentData.predicted_trajectory[Math.min(ptIdx, currentData.predicted_trajectory.length - 1)];
        if (pt) {
            const totalTime = (currentData.states[currentData.states.length - 1]?.timestamp || 0) + pt.t_sec;
            const windSpeed = Math.hypot(pt.wind_u, pt.wind_v);
            const windDir = (Math.atan2(pt.wind_u, pt.wind_v) * 180 / Math.PI + 360) % 360;
            updateHUD({
                timestamp: totalTime,
                altitude_m: pt.alt,
                pressure_hpa: 1013 * Math.exp(-pt.alt / 8500),
                temperature_c: 15 - 0.0065 * pt.alt,
                wind_speed_mps: windSpeed,
                wind_direction_deg: windDir,
                ascent_rate_mps: pt.phase === 'descent' ? -6 : 5,
            });
        }
    }
}

function updateMarkers() {
    const time = clock.elapsedTime;
    [burstMarker, landingMarker].forEach(marker => {
        if (!marker) return;

        if (marker.userData.billboard) {
            marker.children.forEach(child => {
                if (child.userData.isRing) {
                    child.lookAt(camera.position);
                }
            });
        }

        marker.children.forEach(child => {
            if (child.userData.isRing) {
                const scale = 1 + Math.sin(time * 3) * 0.2;
                child.scale.set(scale, scale, scale);
                child.material.opacity = 0.5 + Math.sin(time * 3) * 0.3;
            }
            if (child.userData.isGlow) {
                const s = 1 + Math.sin(time * 2) * 0.15;
                child.scale.set(s, s, s);
            }
            if (child.userData.isBeam) {
                child.rotation.z = time * 2;
                child.material.opacity = 0.2 + Math.sin(time * 4) * 0.15;
            }
        });
    });
}

function animate() {
    requestAnimationFrame(animate);

    const delta = clock.getDelta();

    controls.autoRotate = autoRotate;
    controls.update();

    updateAnimation(delta);
    updateMarkers();

    if (stars) {
        stars.rotation.y += delta * 0.01;
    }

    renderer.render(scene, camera);
}

// ============================================================================
// UI 交互
// ============================================================================

function bindUI() {
    dom.btnLoad.addEventListener('click', () => {
        const seed = parseInt(dom.seedInput.value) || 42;
        loadData(seed);
    });

    dom.btnReload.addEventListener('click', () => {
        if (currentData) {
            animationProgress = 0;
            dom.seedInput.value = (parseInt(dom.seedInput.value) || 42) + 1;
            const seed = parseInt(dom.seedInput.value);
            loadData(seed);
        }
    });

    dom.toggleRotate.addEventListener('change', (e) => {
        autoRotate = e.target.checked;
    });

    dom.toggleAnimate.addEventListener('change', (e) => {
        isAnimating = e.target.checked;
    });

    dom.seedInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            dom.btnLoad.click();
        }
    });
}

function setStatus(type, text) {
    dom.statusIndicator.className = 'status ' + type;
    dom.statusText.textContent = text;
}

function showLoading(show) {
    if (show) {
        dom.loading.classList.add('active');
    } else {
        dom.loading.classList.remove('active');
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ============================================================================
// 启动
// ============================================================================

async function main() {
    initScene();
    initLights();
    initStars();
    initEarth();
    bindUI();
    setStatus('loading', '初始化三维场景...');

    animate();

    // 自动加载演示数据
    const seed = parseInt(dom.seedInput.value) || 42;
    await loadData(seed);
}

// 捕获全局错误
window.addEventListener('error', (e) => {
    console.error('全局错误:', e.error || e.message);
    setStatus('error', '前端错误: ' + (e.message || '未知错误'));
});

window.addEventListener('unhandledrejection', (e) => {
    console.error('未处理的 Promise 拒绝:', e.reason);
});

main();
