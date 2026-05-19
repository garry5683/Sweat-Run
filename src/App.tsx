import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'motion/react';
import { Camera, Play, RefreshCw, Trophy, Zap, Accessibility, ChevronLeft, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';

// --- Constants ---
const LANE_WIDTH = 4;
const LANES = [-LANE_WIDTH, 0, LANE_WIDTH];
const TRACK_LENGTH = 100;
const SEGMENT_SIZE = 20;
const INITIAL_SPEED = 0.1;
const SPEED_INCREMENT = 0.00002;
const GRAVITY = 0.015;
const JUMP_FORCE = 0.35;
const COLORS = {
  bg: 0x050810,
  neonGreen: 0x00f5a0,
  neonBlue: 0x00c8ff,
  neonRed: 0xff4b2b,
  neonPurple: 0xbc13fe,
  gold: 0xffd700,
};

// --- Types ---
type GameState = 'START' | 'COUNTDOWN' | 'RUNNING' | 'GAMEOVER';
type ObstacleType = 'barrier' | 'lowbar' | 'pillar';

interface GameObject {
  mesh: THREE.Object3D;
  lane: number;
  type?: ObstacleType;
  active: boolean;
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>('START');
  const [showTutorial, setShowTutorial] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const [difficulty, setDifficulty] = useState(1);
  const [cursor, setCursor] = useState({ x: 0, y: 0, visible: false, progress: 0, targetId: null as string | null });
  const gameStateRef = useRef<GameState>('START');
  const difficultyRef = useRef(1);

  useEffect(() => {
    difficultyRef.current = difficulty;
  }, [difficulty]);

  useEffect(() => {
    if (gameState === 'COUNTDOWN') {
      setCountdown(5);
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            setGameState('RUNNING');
            gameStateRef.current = 'RUNNING';
            // Scale attributes on start based on final selected difficulty
            const multiplier = [1, 1.25, 1.5][difficultyRef.current - 1];
            gameRef.current.speed = INITIAL_SPEED * multiplier;
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [gameState]);

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);
  const [score, setScore] = useState(0);
  const [distance, setDistance] = useState(0);
  const [bestScore, setBestScore] = useState(() => Number(localStorage.getItem('sweatRunBest')) || 0);
  const [cameraReady, setCameraReady] = useState(false);
  const [isPoseActive, setIsPoseActive] = useState(false);

  // Indicators mapping status
  const [indicators, setIndicators] = useState({
    running: false,
    jump: false,
    duck: false,
    left: false,
    right: false,
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // Game references
  const gameRef = useRef({
    scene: null as THREE.Scene | null,
    camera: null as THREE.PerspectiveCamera | null,
    renderer: null as THREE.WebGLRenderer | null,
    player: null as THREE.Group | null,
    playerParts: {} as Record<string, THREE.Mesh>,
    trackSegments: [] as THREE.Mesh[],
    obstacles: [] as GameObject[],
    coins: [] as GameObject[],
    particles: [] as any[],
    speed: INITIAL_SPEED,
    score: 0,
    distance: 0,
    bestScore: 0,
    currentLane: 1, // 0, 1, 2
    targetX: 0,
    isJumping: false,
    isDucking: false,
    vY: 0,
    clock: new THREE.Clock(),
    spawnTimer: 0,
    coinTimer: 0,
    distanceTimer: 0,
    frame: 0,
    isRunning: false,
    keyboardControls: {
      left: false,
      right: false,
      up: false,
      down: false,
    },
    // MediaPipe detection state
    poseState: {
      baselineNoseY: 0.5,
      baselineHipY: 0.5,
      calibrationFrames: 0,
      runHistory: [] as number[],
      lastLeftKneeY: 0,
      lastRightKneeY: 0,
    }
  });

  // --- External Scripts Loading ---
  useEffect(() => {
    const loadScripts = async () => {
      const scripts = [
        'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js',
        'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js',
        'https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js',
      ];

      for (const src of scripts) {
        if (!document.querySelector(`script[src="${src}"]`)) {
          await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            document.head.appendChild(script);
          });
        }
      }
      initMediaPipe();
    };

    loadScripts();
  }, []);

  const initMediaPipe = () => {
    const win = window as any;
    if (!win.Pose || !win.Camera) return;

    const pose = new win.Pose({
      locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });

    pose.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    pose.onResults(onPoseResults);

    if (videoRef.current) {
      const camera = new win.Camera(videoRef.current, {
        onFrame: async () => {
          await pose.send({ image: videoRef.current! });
        },
        width: 640,
        height: 480,
      });
      camera.start().then(() => setCameraReady(true));
    }
  };

  const onPoseResults = (results: any) => {
    if (!results.poseLandmarks) {
      setIsPoseActive(false);
      return;
    }
    const win = window as any;
    setIsPoseActive(true);
    const landmarks = results.poseLandmarks;
    const nose = landmarks[0];
    const leftWrist = landmarks[15];
    const rightWrist = landmarks[16];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    // Draw overlay
    if (overlayCanvasRef.current) {
      const ctx = overlayCanvasRef.current.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, overlayCanvasRef.current.width, overlayCanvasRef.current.height);
        win.drawConnectors(ctx, landmarks, win.POSE_CONNECTIONS, { color: '#00f5a0', lineWidth: 2 });
        win.drawLandmarks(ctx, landmarks, { color: '#ffffff', lineWidth: 1, radius: 2 });
      }
    }

    // Hand Cursor Logic (Use the wrist that is higher/visible)
    // Map MP coordinates (0-1) to screen percentages
    // MP X is usually mirrored, but our video is scale-x-[-1]
    const activeWrist = leftWrist.visibility > 0.5 || rightWrist.visibility > 0.5 
      ? (leftWrist.y < rightWrist.y ? leftWrist : rightWrist) 
      : null;

    if (activeWrist && (gameStateRef.current === 'START' || gameStateRef.current === 'GAMEOVER' || showTutorial)) {
      // Invert X because the video feed is mirrored
      const cursorX = (1 - activeWrist.x) * 100;
      const cursorY = activeWrist.y * 100;
      
      // Look for interactive elements
      const elements = document.querySelectorAll('[data-hand-select]');
      let foundTarget = null;
      
      elements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const screenX = (cursorX / 100) * window.innerWidth;
        const screenY = (cursorY / 100) * window.innerHeight;
        
        if (
          screenX >= rect.left && 
          screenX <= rect.right && 
          screenY >= rect.top && 
          screenY <= rect.bottom
        ) {
          foundTarget = el.getAttribute('data-hand-select-id');
        }
      });

      setCursor(prev => {
        const isSameTarget = prev.targetId === foundTarget;
        const newProgress = foundTarget 
          ? (isSameTarget ? Math.min(100, prev.progress + 2.5) : 0) 
          : 0;

        if (newProgress >= 100 && prev.progress < 100 && foundTarget) {
          // Trigger click
          const targetEl = document.querySelector(`[data-hand-select-id="${foundTarget}"]`) as HTMLElement;
          if (targetEl) targetEl.click();
        }

        return {
          x: cursorX,
          y: cursorY,
          visible: true,
          progress: newProgress,
          targetId: foundTarget
        };
      });
    } else {
      setCursor(prev => ({ ...prev, visible: false, progress: 0, targetId: null }));
    }

    // Controls Logic
    const state = gameRef.current.poseState;
    const hipCenterY = (landmarks[23].y + landmarks[24].y) / 2;
    const shoulderCenterX = (leftShoulder.x + rightShoulder.x) / 2;

    // Calibration
    if (state.calibrationFrames < 60) {
      state.baselineNoseY = (state.baselineNoseY * state.calibrationFrames + nose.y) / (state.calibrationFrames + 1);
      state.baselineHipY = (state.baselineHipY * state.calibrationFrames + hipCenterY) / (state.calibrationFrames + 1);
      state.calibrationFrames++;
      return;
    }

    // Lane Logic (Mirrored feed)
    const leanThreshold = [0.12, 0.10, 0.08][difficultyRef.current - 1]; 
    const neutralThreshold = [0.06, 0.05, 0.04][difficultyRef.current - 1];
    let nextLane = gameRef.current.currentLane;
    
    // User leaning Left (detected as screen right)
    const isLeaningLeft = shoulderCenterX > 0.5 + leanThreshold;
    // User leaning Right (detected as screen left)
    const isLeaningRight = shoulderCenterX < 0.5 - leanThreshold;
    const isNeutral = Math.abs(shoulderCenterX - 0.5) < neutralThreshold;

    if (isLeaningLeft) nextLane = 0; // Left
    else if (isLeaningRight) nextLane = 2; // Right
    else if (isNeutral) nextLane = 1; // Center
    
    // else keep currentLane

    // Jump / Duck - adjusted thresholds
    const jumpThreshold = [0.15, 0.12, 0.09][difficultyRef.current - 1];
    const duckThreshold = [0.18, 0.15, 0.12][difficultyRef.current - 1];
    const isJumpingPose = nose.y < state.baselineNoseY - jumpThreshold;
    const isDuckingPose = nose.y > state.baselineNoseY + duckThreshold;

    if (nextLane !== gameRef.current.currentLane) {
      gameRef.current.currentLane = nextLane;
      gameRef.current.targetX = LANES[nextLane];
    }

    // Run in place detection (leg variance and movement speed)
    const leftKnee = landmarks[25];
    const rightKnee = landmarks[26];
    
    // Height difference + movement speed
    const variance = Math.abs(leftKnee.y - rightKnee.y);
    const movement = Math.abs(leftKnee.y - state.lastLeftKneeY) + Math.abs(rightKnee.y - state.lastRightKneeY);
    
    state.lastLeftKneeY = leftKnee.y;
    state.lastRightKneeY = rightKnee.y;
    
    const runSignal = variance + movement;
    
    state.runHistory.push(runSignal);
    if (state.runHistory.length > 10) state.runHistory.shift();
    const avgSignal = state.runHistory.reduce((a, b) => a + b, 0) / state.runHistory.length;
    // Adjusted sensitivity based on difficulty
    const isRunningPose = avgSignal > [0.02, 0.03, 0.04][difficultyRef.current - 1];

    // Update state for HUD indicators
    setIndicators({
      running: isRunningPose,
      jump: isJumpingPose,
      duck: isDuckingPose,
      left: isLeaningLeft,
      right: isLeaningRight,
    });

    // Apply to game
    gameRef.current.isRunning = isRunningPose;
    
    // Only update game controls if Three.js scene is initialized
    if (gameRef.current.scene) {
      if (isJumpingPose && !gameRef.current.isJumping) {
        gameRef.current.vY = JUMP_FORCE;
        gameRef.current.isJumping = true;
      }
      gameRef.current.isDucking = isDuckingPose;
    }
  };

  // --- Three.js Game Logic ---
  useEffect(() => {
    if (!canvasRef.current) return;

    // Setup Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    scene.fog = new THREE.FogExp2(COLORS.bg, 0.035);

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 3.5, 8);
    camera.lookAt(0, 1, 0);

    const renderer = new THREE.WebGLRenderer({ canvas: canvasRef.current, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 5);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Side Neon Walls
    const wallGeo = new THREE.PlaneGeometry(200, 20);
    const leftWallMat = new THREE.MeshPhongMaterial({ color: COLORS.neonGreen, emissive: COLORS.neonGreen, emissiveIntensity: 0.5, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    const rightWallMat = new THREE.MeshPhongMaterial({ color: COLORS.neonBlue, emissive: COLORS.neonBlue, emissiveIntensity: 0.5, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    
    const leftWall = new THREE.Mesh(wallGeo, leftWallMat);
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.set(-8, 5, -50);
    scene.add(leftWall);

    const rightWall = new THREE.Mesh(wallGeo, rightWallMat);
    rightWall.rotation.y = -Math.PI / 2;
    rightWall.position.set(8, 5, -50);
    scene.add(rightWall);

    // Side Pulsing Lights
    const pulseLight1 = new THREE.PointLight(COLORS.neonGreen, 20, 15);
    pulseLight1.position.set(-7, 2, 0);
    scene.add(pulseLight1);

    const pulseLight2 = new THREE.PointLight(COLORS.neonBlue, 20, 15);
    pulseLight2.position.set(7, 2, 0);
    scene.add(pulseLight2);

    // Track Segments
    const trackSegments: THREE.Mesh[] = [];
    const segGeo = new THREE.PlaneGeometry(16, SEGMENT_SIZE);
    const segMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });

    for (let i = 0; i < 10; i++) {
        const seg = new THREE.Mesh(segGeo, segMat);
        seg.rotation.x = -Math.PI / 2;
        seg.position.z = -i * SEGMENT_SIZE;
        seg.receiveShadow = true;
        
        // Lane lines
        const lines = new THREE.GridHelper(16, 4, 0x444444, 0x333333);
        lines.rotation.x = Math.PI / 2;
        lines.position.z = 0.01;
        seg.add(lines);

        scene.add(seg);
        trackSegments.push(seg);
    }

    // Player Character
    const playerGroup = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const limbsMat = new THREE.MeshStandardMaterial({ color: COLORS.neonGreen });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.4), bodyMat);
    torso.position.y = 1.2;
    torso.castShadow = true;
    playerGroup.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), bodyMat);
    head.position.y = 1.85;
    playerGroup.add(head);

    const legGeo = new THREE.BoxGeometry(0.2, 0.6, 0.2);
    const leftLeg = new THREE.Mesh(legGeo, limbsMat);
    leftLeg.position.set(-0.15, 0.5, 0);
    playerGroup.add(leftLeg);

    const rightLeg = new THREE.Mesh(legGeo, limbsMat);
    rightLeg.position.set(0.15, 0.5, 0);
    playerGroup.add(rightLeg);

    const armGeo = new THREE.BoxGeometry(0.15, 0.6, 0.15);
    const leftArm = new THREE.Mesh(armGeo, limbsMat);
    leftArm.position.set(-0.4, 1.2, 0);
    playerGroup.add(leftArm);

    const rightArm = new THREE.Mesh(armGeo, limbsMat);
    rightArm.position.set(0.4, 1.2, 0);
    playerGroup.add(rightArm);

    scene.add(playerGroup);

    gameRef.current = {
      ...gameRef.current,
      scene,
      camera,
      renderer,
      player: playerGroup,
      playerParts: { leftLeg, rightLeg, leftArm, rightArm },
      trackSegments,
    };

    // Keyboard controls
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') moveLane(-1);
      if (e.key === 'ArrowRight') moveLane(1);
      if (e.key === 'ArrowUp' || e.key === ' ') jump();
      if (e.key === 'ArrowDown') gameRef.current.isDucking = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') gameRef.current.isDucking = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Start Loop
    let lastTime = performance.now();
    const animate = (time: number) => {
      const dt = Math.min((time - lastTime) / 16.6, 3);
      lastTime = time;

      update(dt);
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      renderer.dispose();
    };
  }, []);

  const moveLane = (dir: number) => {
    const next = Math.max(0, Math.min(2, gameRef.current.currentLane + dir));
    gameRef.current.currentLane = next;
    gameRef.current.targetX = LANES[next];
  };

  const jump = () => {
    if (!gameRef.current.isJumping) {
      gameRef.current.vY = JUMP_FORCE;
      gameRef.current.isJumping = true;
    }
  };

  const spawnObstacle = () => {
    const types: ObstacleType[] = ['barrier', 'lowbar', 'pillar'];
    const type = types[Math.floor(Math.random() * types.length)];
    const laneIdx = Math.floor(Math.random() * 3);
    const laneX = LANES[laneIdx];

    let mesh: THREE.Mesh;
    if (type === 'barrier') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 0.5), new THREE.MeshStandardMaterial({ color: 0xff0055, emissive: 0xff0055, emissiveIntensity: 2.0 }));
      mesh.position.set(laneX, 0.3, -TRACK_LENGTH);
    } else if (type === 'lowbar') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.3, 0.5), new THREE.MeshStandardMaterial({ color: 0xff9900, emissive: 0xff9900, emissiveIntensity: 2.0 }));
      mesh.position.set(laneX, 1.45, -TRACK_LENGTH); // Adjusted Z to be more consistent
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 6, 1), new THREE.MeshStandardMaterial({ color: 0xff00ff, emissive: 0xff00ff, emissiveIntensity: 2.0 }));
      mesh.position.set(laneX, 3, -TRACK_LENGTH);
    }

    gameRef.current.scene?.add(mesh);
    gameRef.current.obstacles.push({ mesh, lane: laneIdx, type, active: true });
  };

  const spawnCoin = () => {
    const laneIdx = Math.floor(Math.random() * 3);
    const laneX = LANES[laneIdx];
    
    for (let i = 0; i < 4; i++) {
        const torus = new THREE.Mesh(
            new THREE.TorusGeometry(0.3, 0.08, 8, 16),
            new THREE.MeshStandardMaterial({ color: COLORS.gold, metalness: 1, roughness: 0.2 })
        );
        torus.position.set(laneX, 0.8, -TRACK_LENGTH - i * 1.5);
        gameRef.current.scene?.add(torus);
        gameRef.current.coins.push({ mesh: torus, lane: laneIdx, active: true });
    }
  };

  const createParticle = (pos: THREE.Vector3, color: number) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.1, 4, 4), new THREE.MeshBasicMaterial({ color }));
    mesh.position.copy(pos);
    gameRef.current.scene?.add(mesh);
    gameRef.current.particles.push({
      mesh,
      v: new THREE.Vector3((Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2, (Math.random()-0.5)*0.2),
      life: 1.0
    });
  };

  const update = (dt: number) => {
    const g = gameRef.current;
    if (gameStateRef.current !== 'RUNNING') return;

    g.frame++;
    g.speed += SPEED_INCREMENT * dt;
    
    // Track movement & recycling
    g.trackSegments.forEach(seg => {
      seg.position.z += g.speed * dt;
      if (seg.position.z > SEGMENT_SIZE) {
        seg.position.z -= g.trackSegments.length * SEGMENT_SIZE;
      }
    });

    // Player Movement
    if (g.player) {
      g.player.position.x = THREE.MathUtils.lerp(g.player.position.x, g.targetX, 0.15 * dt);
      
      // Physics
      g.vY -= GRAVITY * dt;
      g.player.position.y += g.vY * dt;
      if (g.player.position.y <= 0) {
        g.player.position.y = 0;
        g.vY = 0;
        g.isJumping = false;
      }

      // Ducking Scale
      const targetScale = g.isDucking ? 0.55 : 1.0;
      g.player.scale.y = THREE.MathUtils.lerp(g.player.scale.y, targetScale, 0.2 * dt);

      // Animation
      const animSpeed = g.isRunning ? 0.4 : 0.1;
      const legRot = Math.sin(g.frame * animSpeed) * 0.5;
      g.playerParts.leftLeg.rotation.x = legRot;
      g.playerParts.rightLeg.rotation.x = -legRot;
      g.playerParts.leftArm.rotation.x = -legRot;
      g.playerParts.rightArm.rotation.x = legRot;

      // Trail
      if (g.frame % 3 === 0) {
         createParticle(new THREE.Vector3(g.player.position.x, 0.1, g.player.position.z), COLORS.neonGreen);
      }
    }

    // Camera Dynamic Follow
    if (g.camera && g.player) {
      // 1. Smoothly follow player lane (horizontal lag)
      const targetCamX = g.player.position.x;
      g.camera.position.x = THREE.MathUtils.lerp(g.camera.position.x, targetCamX, 0.05 * dt);

      // 2. Smoothly follow player height (vertical responsiveness)
      const targetCamY = 3.5 + (g.player.position.y * 0.5); 
      g.camera.position.y = THREE.MathUtils.lerp(g.camera.position.y, targetCamY, 0.05 * dt);

      // 3. Dynamic Tilting
      // Tilt camera based on sideways movement speed
      const lateralVelocity = (g.player.position.x - g.targetX) * 0.1;
      g.camera.rotation.z = THREE.MathUtils.lerp(g.camera.rotation.z, -lateralVelocity, 0.1 * dt);
      
      // Look at a target ahead of player
      g.camera.lookAt(g.player.position.x * 0.3, 1, 0);
    }

    // Spawning
    g.spawnTimer -= dt;
    if (g.spawnTimer <= 0) {
      spawnObstacle();
      g.spawnTimer = Math.max(60, 120 - g.speed * 100);
    }

    g.coinTimer -= dt;
    if (g.coinTimer <= 0) {
      spawnCoin();
      g.coinTimer = 120;
    }

    // Distance
    g.distanceTimer += dt;
    if (g.distanceTimer > 10) {
       g.distance += Math.floor(g.speed * 2);
       setDistance(g.distance);
       g.distanceTimer = 0;
    }

    // Obstacles Update
    g.obstacles.forEach((obj, idx) => {
      obj.mesh.position.z += g.speed * dt;
      
      // Collision
      if (obj.active && g.player) {
        const dx = Math.abs(obj.mesh.position.x - g.player.position.x);
        const dz = Math.abs(obj.mesh.position.z - g.player.position.z);
        
        if (dz < 1 && dx < 1.5) {
           // Refined height check
           let hit = false;
           if (obj.type === 'barrier' && g.player.position.y < 0.6) hit = true;
           if (obj.type === 'lowbar' && !g.isDucking) hit = true;
           if (obj.type === 'pillar') hit = true;

           if (hit) {
             gameOver();
           } else if (obj.active) {
              g.score += 50;
              setScore(g.score);
              obj.active = false;
              for(let i=0; i<5; i++) createParticle(obj.mesh.position, COLORS.neonGreen);
           }
        }
      }

      // Cleanup
      if (obj.mesh.position.z > 10) {
        g.scene?.remove(obj.mesh);
        g.obstacles.splice(idx, 1);
      }
    });

    // Coins Update
    g.coins.forEach((obj, idx) => {
      obj.mesh.position.z += g.speed * dt;
      obj.mesh.rotation.y += 0.05 * dt;

      if (obj.active && g.player) {
        const dist = obj.mesh.position.distanceTo(g.player.position);
        if (dist < 1.5) {
          g.score += 10;
          setScore(g.score);
          obj.active = false;
          g.scene?.remove(obj.mesh);
          for(let i=0; i<5; i++) createParticle(obj.mesh.position, COLORS.gold);
        }
      }

      if (obj.mesh.position.z > 10) {
        g.scene?.remove(obj.mesh);
        g.coins.splice(idx, 1);
      }
    });

    // Particles
    g.particles.forEach((p, idx) => {
      p.mesh.position.add(p.v);
      p.life -= 0.02 * dt;
      p.mesh.scale.setScalar(p.life);
      if (p.life <= 0) {
        g.scene?.remove(p.mesh);
        g.particles.splice(idx, 1);
      }
    });
  };

  const startGame = () => {
    setGameState('COUNTDOWN');
    gameStateRef.current = 'COUNTDOWN';
    gameRef.current.score = 0;
    gameRef.current.distance = 0;
    setScore(0);
    setDistance(0);
    gameRef.current.speed = INITIAL_SPEED;
    gameRef.current.obstacles.forEach(o => gameRef.current.scene?.remove(o.mesh));
    gameRef.current.coins.forEach(o => gameRef.current.scene?.remove(o.mesh));
    gameRef.current.obstacles = [];
    gameRef.current.coins = [];
  };

  const gameOver = () => {
    setGameState('GAMEOVER');
    gameStateRef.current = 'GAMEOVER';
    if (gameRef.current.score > bestScore) {
      setBestScore(gameRef.current.score);
      localStorage.setItem('sweatRunBest', String(gameRef.current.score));
    }
  };

  return (
    <div className="relative w-full h-screen overflow-hidden bg-[#050810] font-rajdhani border-8 border-[#0a0f1d]">
      {/* Canvas Layer */}
      <canvas ref={canvasRef} className="absolute inset-0 z-0" />

      {/* Hand Cursor Indicator */}
      {cursor.visible && (
        <div 
          className="fixed z-[100] pointer-events-none transform -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}
        >
          <div className="relative w-12 h-12">
            {/* Outer Progress Ring */}
            <svg className="absolute inset-0 w-full h-full -rotate-90">
              <circle
                cx="24" cy="24" r="20"
                fill="none"
                stroke="white"
                strokeWidth="2"
                className="opacity-20"
              />
              <circle
                cx="24" cy="24" r="20"
                fill="none"
                stroke="#00f5a0"
                strokeWidth="4"
                strokeDasharray="125.6"
                strokeDashoffset={125.6 - (125.6 * cursor.progress) / 100}
                strokeLinecap="round"
                className="transition-all duration-75"
              />
            </svg>
            {/* Center Dot */}
            <div className={`absolute inset-0 m-auto w-3 h-3 rounded-full bg-white shadow-[0_0_15px_rgba(255,255,255,0.8)] ${cursor.targetId ? 'scale-150 bg-[#00f5a0]' : ''} transition-transform`} />
            
            {cursor.targetId && (
              <div className="absolute top-14 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/60 backdrop-blur-md px-2 py-1 rounded text-[10px] text-[#00f5a0] font-black uppercase tracking-tighter">
                Selecting...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Decorative Grid Side Labels */}
      <div className="absolute right-0 top-[20%] w-12 h-[60%] flex flex-col justify-around items-center border-l border-[#00c8ff]/20 bg-white/5 opacity-40 z-10 hidden md:flex">
        <div className="[writing-mode:vertical-rl] rotate-180 text-[10px] tracking-[0.5em] font-bold text-[#00c8ff] uppercase">Movement Calibration Engine</div>
      </div>

      {/* HUD Layer */}
      {gameState === 'RUNNING' && (
        <div className="absolute top-0 left-0 w-full p-8 flex justify-between items-start z-10 pointer-events-none">
          <div className="flex flex-col">
            <div className="text-xs uppercase tracking-[0.2em] opacity-60 font-semibold text-[#00f5a0]">Total Score</div>
            <div className="text-5xl font-black text-[#00f5a0] tracking-tighter font-bebas">{score.toLocaleString().padStart(7, '0')}</div>
          </div>
          
          <div className="flex flex-col items-center p-4 bg-[#0a0f1d] border border-[#00c8ff]/30 rounded-lg shadow-[0_0_20px_rgba(0,200,255,0.1)]">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[#00c8ff] font-bold">Pace Multiplier</div>
            <div className="text-3xl font-bold text-white font-bebas">x{(gameRef.current.speed / INITIAL_SPEED).toFixed(2)}</div>
            <div className="text-[10px] text-white/40 mt-1">{distance}M TRAVELLED</div>
          </div>

          <div className="flex flex-col items-end">
            <div className="text-xs uppercase tracking-[0.2em] opacity-60 font-semibold text-[#ff9d00]">Personal Best</div>
            <div className="text-4xl font-black text-[#ff9d00] tracking-tighter font-bebas">{bestScore.toLocaleString().padStart(7, '0')}</div>
          </div>
        </div>
      )}

      {/* Control Indicator Chips */}
      {gameState === 'RUNNING' && (
        <div className="absolute bottom-8 left-8 flex gap-3 z-30">
              <div key="hud-run"><IndicatorChip active={indicators.running} label="RUNNING" emoji="🏃" /></div>
              <div key="hud-jump"><IndicatorChip active={indicators.jump} label="JUMP" emoji="🦘" /></div>
              <div key="hud-duck"><IndicatorChip active={indicators.duck} label="DUCK" emoji="🙇" /></div>
              <div key="hud-left"><IndicatorChip active={indicators.left} label="LEFT" emoji="⬅️" /></div>
              <div key="hud-right"><IndicatorChip active={indicators.right} label="RIGHT" emoji="➡️" /></div>
        </div>
      )}

      {/* Camera Preview */}
      <div className="absolute bottom-8 right-8 w-[220px] aspect-[4/3] bg-black border-2 border-[#00f5a0] rounded-lg shadow-lg overflow-hidden z-20 group">
        <video ref={videoRef} className="w-full h-full object-cover scale-x-[-1]" playsInline />
        <canvas ref={overlayCanvasRef} className="absolute inset-0 w-full h-full scale-x-[-1]" width={640} height={480} />
        <div className="absolute top-2 left-2 px-2 py-0.5 bg-[#00f5a0] text-black font-black text-[9px] uppercase z-40 flex items-center gap-1">
          <Accessibility size={10} />
          {isPoseActive ? "POSE TRACKING" : "WAITING..."}
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-[#00f5a0]/10 to-transparent pointer-events-none"></div>
      </div>

      {/* Screens */}
      <AnimatePresence>
        {gameState === 'START' && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#050810]/70 backdrop-blur-md p-4 text-center overflow-hidden"
          >
            {/* Perspective Grid for Start Screen */}
            <div className="absolute inset-0 opacity-20 pointer-events-none overflow-hidden">
               <div className="perspective-grid"></div>
            </div>

            <div className="relative z-20 flex flex-col items-center w-full max-w-4xl">
              <div className="mb-12 text-center">
                <motion.h1 
                  initial={{ y: -50, skewX: -10 }} animate={{ y: 0, skewX: -10 }}
                  className="text-[100px] md:text-[140px] leading-none font-black tracking-tighter uppercase italic bg-gradient-to-b from-[#00f5a0] to-[#00c8ff] bg-clip-text text-transparent drop-shadow-[0_10px_20px_rgba(0,245,160,0.3)] mb-2"
                >
                  SWEAT RUN
                </motion.h1>
                <div className="text-xl font-medium tracking-[0.4em] uppercase text-white/40">The Interactive 3D Workout Engine</div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-3xl mb-12">
                <div key="card-run"><TutorialCard title="Run In Place" desc="Drive character forward momentum" emoji="🏃" color="border-[#00f5a0]" /></div>
                <div key="card-lean"><TutorialCard title="Lean Side-to-Side" desc="Switch lanes to dodge obstacles" emoji="⬅️" color="border-[#00c8ff]" /></div>
                <div key="card-jump"><TutorialCard title="Jump High" desc="Leap over low red barriers" emoji="🦘" color="border-[#ff3e3e]" /></div>
                <div key="card-squat"><TutorialCard title="Squat Low" desc="Duck under orange high bars" emoji="🙇" color="border-[#ff9d00]" /></div>
              </div>

              <button 
                onClick={startGame}
                disabled={!cameraReady}
                id="btn-start"
                data-hand-select
                data-hand-select-id="start-workout"
                className={`px-12 py-5 font-black text-2xl uppercase tracking-[0.2em] rounded-sm transition-all shadow-[0_0_40px_rgba(0,245,160,0.4)] mb-6
                  ${cameraReady 
                    ? 'bg-[#00f5a0] text-[#050810] hover:scale-105 active:scale-95 cursor-pointer' 
                    : 'bg-white/10 text-white/40 cursor-not-allowed'
                  }`}
              >
                {cameraReady ? 'Start Workout' : 'Initializing...'}
              </button>

              <div className="w-full max-w-sm mb-8">
                  <div className="flex justify-between text-white/60 mb-2 font-bold uppercase tracking-widest text-sm">
                      <span>Easy</span>
                      <span>Difficulty</span>
                      <span>Hard</span>
                  </div>
                  <input 
                    type="range" min="1" max="3" value={difficulty} 
                    onChange={(e) => setDifficulty(Number(e.target.value))}
                    className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[#00f5a0]"
                  />
              </div>
              
              <button 
                onClick={() => setShowTutorial(true)}
                data-hand-select
                data-hand-select-id="show-tutorial"
                className="px-8 py-3 bg-white/10 text-white font-bold uppercase tracking-widest rounded-sm hover:bg-white/20 transition-all mb-6"
              >
                  How to Play
              </button>

              <div className="flex items-center gap-2 text-white/40 text-xs font-semibold uppercase tracking-widest">
                <div className={`w-2 h-2 rounded-full ${cameraReady ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}></div>
                Camera Status: {cameraReady ? 'Pose Detection Active' : 'Waiting for Access'}
              </div>
            </div>
          </motion.div>
        )}
        
        <TutorialModal isOpen={showTutorial} onClose={() => setShowTutorial(false)} indicators={indicators} />

        {gameState === 'COUNTDOWN' && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <h1 className="text-[200px] font-black text-[#00f5a0] font-bebas tabular-nums">{countdown}</h1>
          </div>
        )}

        {gameState === 'GAMEOVER' && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#050810]/95 p-4 text-center border-24 border-[#0a0f1d]"
          >
            <h1 className="text-9xl font-black text-[#ff3e3e] italic tracking-tighter italic mb-8 drop-shadow-[0_0_30px_rgba(255,62,62,0.4)]">GAME OVER</h1>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-4xl mb-12">
              <FinalStat label="Final Score" value={score.toLocaleString()} color="text-[#00f5a0]" />
              <FinalStat label="Distance" value={`${distance}M`} color="text-white" />
              <FinalStat label="Personal Best" value={bestScore.toLocaleString()} color="text-[#ff9d00]" />
            </div>

            <button 
              onClick={startGame}
              data-hand-select
              data-hand-select-id="restart-game"
              className="px-16 py-6 bg-white text-[#050810] rounded-sm font-black text-2xl uppercase tracking-[0.2em] hover:scale-105 active:scale-95 transition-all shadow-[0_0_50px_rgba(255,255,255,0.3)]"
            >
              Restart Engine
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IndicatorChip({ active, label, emoji }: { active: boolean, label: string, emoji: string }) {
  return (
    <div className={`px-4 py-3 font-bold text-xs uppercase rounded-sm flex items-center gap-2 transition-all duration-300
      ${active ? 'bg-[#00f5a0] text-[#050810]' : 'bg-[#0a0f1d] border border-white/20 text-white/30'}
    `}>
      <span className={`text-lg ${!active && 'opacity-40'}`}>{emoji}</span>
      {label}
    </div>
  );
}

function TutorialCard({ title, desc, emoji, color }: { title: string, desc: string, emoji: string, color: string }) {
  return (
    <div className={`p-6 bg-[#0a0f1d]/80 border-l-4 ${color} flex gap-4 items-center text-left hover:bg-[#0a0f1d] transition-all`}>
      <div className="text-4xl">{emoji}</div>
      <div>
        <div className="text-white font-bold uppercase tracking-wider">{title}</div>
        <div className="text-sm text-white/50">{desc}</div>
      </div>
    </div>
  );
}

function FinalStat({ label, value, color }: { label: string, value: string | number, color: string }) {
  return (
    <div className="flex flex-col items-center bg-[#0a0f1d] p-8 border border-white/5 rounded-lg">
      <div className="text-xs uppercase tracking-[0.4em] opacity-40 mb-2 font-bold">{label}</div>
      <div className={`text-5xl font-black font-bebas tracking-tighter ${color}`}>{value}</div>
    </div>
  );
}

function TutorialModal({ isOpen, onClose, indicators }: { isOpen: boolean, onClose: () => void, indicators: any }) {
  if (!isOpen) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#050810]/95 p-6 md:p-12">
      <div className="w-full max-w-3xl bg-[#0a0f1d] border border-white/10 p-8 rounded-2xl">
        <h2 className="text-4xl font-bebas mb-6 text-white text-center">How to Play</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <div key="modal-card-run"><TutorialCard title="RUN" desc="Move legs in place" emoji="🏃" color="border-[#00f5a0]" /></div>
            <div key="modal-card-lean"><TutorialCard title="LEAN" desc="Shift body left/right" emoji="⬅️" color="border-[#00c8ff]" /></div>
            <div key="modal-card-jump"><TutorialCard title="JUMP" desc="Lift head up" emoji="🦘" color="border-[#ff3e3e]" /></div>
            <div key="modal-card-duck"><TutorialCard title="DUCK" desc="Lower head / squat" emoji="🙇" color="border-[#ff9d00]" /></div>
        </div>
        <div className="bg-black/40 p-6 rounded-xl border border-white/5 mb-8">
            <h3 className="text-xl font-bebas mb-4 text-center">Control Test</h3>
            <div className="flex justify-center gap-3">
              <div key="modal-ind-run"><IndicatorChip active={indicators.running} label="RUNNING" emoji="🏃" /></div>
              <div key="modal-ind-jump"><IndicatorChip active={indicators.jump} label="JUMP" emoji="🦘" /></div>
              <div key="modal-ind-duck"><IndicatorChip active={indicators.duck} label="DUCK" emoji="🙇" /></div>
              <div key="modal-ind-left"><IndicatorChip active={indicators.left} label="LEFT" emoji="⬅️" /></div>
              <div key="modal-ind-right"><IndicatorChip active={indicators.right} label="RIGHT" emoji="➡️" /></div>
            </div>
            <p className="text-center text-xs opacity-50 mt-4">Perform a move to see the indicator light up!</p>
        </div>
        <button 
          onClick={onClose} 
          data-hand-select
          data-hand-select-id="close-tutorial"
          className="w-full py-4 bg-[#00f5a0] text-[#050810] font-black uppercase tracking-widest rounded-sm hover:scale-105 active:scale-95 transition-all"
        >
          Close Tutorial
        </button>
      </div>
    </div>
  );
}

