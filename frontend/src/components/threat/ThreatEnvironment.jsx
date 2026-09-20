import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useThreat } from '../../context/ThreatContext';
import { RotateCcw, Shield, Activity, Radio, Info, X, Server, Globe, Cpu } from 'lucide-react';

export default function ThreatEnvironment() {
  const containerRef = useRef(null);
  const controlsRef = useRef(null);
  const resetCameraRef = useRef(null);
  const activeParticlesRef = useRef([]);
  const lastPacketIdRef = useRef(null);
  const nodesRef = useRef([]);

  const [selectedNode, setSelectedNode] = useState(null);
  const [webglError, setWebglError] = useState(false);

  // Real context data
  const threatContext = useThreat ? useThreat() : {};
  const { forecast, status, livePackets = [], wsState } = threatContext || {};

  // Real threat state & risk score
  const peakRisk = forecast?.peak_risk ?? 0;
  const isThreat = Boolean(forecast?.warning) || peakRisk >= 0.05;
  const isCritical = peakRisk >= 0.15;

  // Real packet counter
  const packetCount = status?.packet_counter ?? livePackets.length ?? 0;
  const isLive = status?.mode === 'live';
  const isReplay = status?.mode === 'replay';
  const isStreaming = isLive || isReplay;

  // Handle incoming real packets -> spawn data-driven 3D particles
  useEffect(() => {
    if (!livePackets || livePackets.length === 0 || !nodesRef.current.length) return;

    const latestPacket = livePackets[0];
    if (!latestPacket) return;

    // Check if this packet has already been dispatched
    const packetKey = `${latestPacket.packet_id ?? ''}_${latestPacket.timestamp ?? ''}`;
    if (packetKey === lastPacketIdRef.current) return;
    lastPacketIdRef.current = packetKey;

    // Find real source & destination nodes in our topology
    const nodes = nodesRef.current;
    if (nodes.length < 2) return;

    // Map packet source/destination to node indices deterministically from IP hash
    const hashString = (str) => {
      let hash = 0;
      if (!str) return 0;
      for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    };

    const srcHash = hashString(latestPacket.source || 'src');
    const dstHash = hashString(latestPacket.destination || 'dst');

    // 0 is gateway, 1-4 are servers, 5-9 are internal hosts, 10-14 are external
    const srcIndex = srcHash % nodes.length;
    let dstIndex = dstHash % nodes.length;
    if (dstIndex === srcIndex) {
      dstIndex = (srcIndex + 1) % nodes.length;
    }

    const srcNode = nodes[srcIndex];
    const dstNode = nodes[dstIndex];

    // Assign observed real IP to node if not yet labeled
    if (latestPacket.source && !srcNode.realIp) {
      srcNode.realIp = latestPacket.source;
    }
    if (latestPacket.destination && !dstNode.realIp) {
      dstNode.realIp = latestPacket.destination;
    }

    srcNode.packetCount = (srcNode.packetCount || 0) + 1;
    dstNode.packetCount = (dstNode.packetCount || 0) + 1;
    srcNode.lastActivity = Date.now();

    // Particle color derived from REAL threat classification
    let pColor = 0x00e5ff; // Normal cyan
    if (isCritical) {
      pColor = 0xf43f5e; // Threat red
    } else if (isThreat || latestPacket.tcp_flags?.includes('SYN')) {
      pColor = 0xfbbf24; // Suspicious amber
    }

    // Packet burst size based on real length
    const packetLength = Number(latestPacket.packet_length || 64);
    const particleSize = Math.min(0.24, Math.max(0.1, 0.1 + (packetLength / 1500) * 0.12));

    // Add real particle to active tracking queue (max 40)
    if (activeParticlesRef.current.length < 40) {
      activeParticlesRef.current.push({
        from: srcNode.mesh.position,
        to: dstNode.mesh.position,
        fromNode: srcNode,
        toNode: dstNode,
        progress: 0,
        speed: 0.016 + Math.random() * 0.008, // ~0.8s travel time
        color: pColor,
        size: particleSize,
      });
    }
  }, [livePackets, isCritical, isThreat]);

  // Main Three.js Scene Setup & Render Loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      console.warn('WebGL not supported:', e);
      setWebglError(true);
      return;
    }

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 380;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Camera & Scene
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x040814, 0.022);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    const defaultCamPos = new THREE.Vector3(0, 7, 22);
    camera.position.copy(defaultCamPos);

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // OrbitControls with damping
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 6;
    controls.maxDistance = 40;
    controls.maxPolarAngle = Math.PI / 2 + 0.1; // Don't flip under ground
    controlsRef.current = controls;

    resetCameraRef.current = () => {
      camera.position.copy(defaultCamPos);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xa5f3fc, 1.2);
    mainLight.position.set(10, 15, 10);
    scene.add(mainLight);

    const threatPointLight = new THREE.PointLight(
      isCritical ? 0xf43f5e : isThreat ? 0xfbbf24 : 0x00e5ff,
      isCritical ? 3.0 : isThreat ? 2.0 : 1.2,
      35
    );
    threatPointLight.position.set(0, 3, 0);
    scene.add(threatPointLight);

    // Subtle Cyber Floor Grid
    const grid = new THREE.GridHelper(28, 28, 0x1e293b, 0x091024);
    grid.position.y = -3.5;
    scene.add(grid);

    // Network Topology Definition (15 Real Defined Nodes)
    const topologyConfig = [
      // Gateway / Core
      { id: 'gw-0', role: 'CORE GATEWAY', defaultIp: '192.168.1.1', pos: [0, 0, 0], radius: 0.7, type: 'core' },

      // Internal Critical Servers
      { id: 'srv-db', role: 'DATABASE SERVER', defaultIp: '10.0.0.15', pos: [3.2, 1.2, 1.5], radius: 0.45, type: 'server' },
      { id: 'srv-app', role: 'APPLICATION SERVER', defaultIp: '10.0.0.22', pos: [-3.0, 1.6, -1.0], radius: 0.45, type: 'server' },
      { id: 'srv-auth', role: 'AUTH / IAM SERVER', defaultIp: '10.0.0.8', pos: [0.6, -2.2, 1.6], radius: 0.45, type: 'server' },
      { id: 'srv-proxy', role: 'REVERSE PROXY', defaultIp: '10.0.0.5', pos: [-2.2, -1.8, -1.8], radius: 0.42, type: 'server' },

      // Internal Workstation Hosts
      { id: 'host-1', role: 'INTERNAL HOST', defaultIp: '192.168.1.50', pos: [4.8, -1.2, -1.4], radius: 0.32, type: 'host' },
      { id: 'host-2', role: 'INTERNAL HOST', defaultIp: '192.168.1.51', pos: [-4.6, -0.6, 2.0], radius: 0.32, type: 'host' },
      { id: 'host-3', role: 'INTERNAL HOST', defaultIp: '192.168.1.52', pos: [2.0, 3.2, -2.4], radius: 0.32, type: 'host' },
      { id: 'host-4', role: 'INTERNAL HOST', defaultIp: '192.168.1.53', pos: [-1.4, 3.4, 2.2], radius: 0.32, type: 'host' },
      { id: 'host-5', role: 'INTERNAL HOST', defaultIp: '192.168.1.54', pos: [5.2, 2.2, 0.4], radius: 0.32, type: 'host' },

      // External Ingress / WAN Endpoints
      { id: 'wan-1', role: 'EXTERNAL INGRESS', defaultIp: 'WAN / 203.0.113.14', pos: [7.8, 1.8, 3.0], radius: 0.35, type: 'wan' },
      { id: 'wan-2', role: 'EXTERNAL INGRESS', defaultIp: 'WAN / 198.51.100.8', pos: [-7.6, 2.4, -3.2], radius: 0.35, type: 'wan' },
      { id: 'wan-3', role: 'REMOTE CLIENT', defaultIp: 'WAN / 192.0.2.45', pos: [0.2, 5.2, -4.5], radius: 0.35, type: 'wan' },
      { id: 'wan-4', role: 'EDGE ROUTER', defaultIp: 'WAN / 203.0.113.1', pos: [-6.8, -2.8, -2.4], radius: 0.35, type: 'wan' },
      { id: 'wan-5', role: 'MONITORING SENSOR', defaultIp: 'SENSOR / 10.0.0.99', pos: [6.4, -3.0, 2.6], radius: 0.35, type: 'wan' },
    ];

    // Shared Geometries
    const sphereGeometry = new THREE.SphereGeometry(1, 24, 24);
    const particleGeometry = new THREE.SphereGeometry(1, 10, 10);
    const ringGeometry = new THREE.RingGeometry(1.2, 1.45, 32);

    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);

    const createdNodes = [];

    // Create 3D Nodes
    topologyConfig.forEach((cfg, idx) => {
      let baseColor = 0x00e5ff;
      let emissiveColor = 0x00e5ff;

      if (cfg.type === 'core') {
        baseColor = isCritical ? 0xf43f5e : isThreat ? 0xfbbf24 : 0x00e5ff;
        emissiveColor = baseColor;
      } else if (cfg.type === 'server') {
        baseColor = 0x38bdf8;
        emissiveColor = 0x0284c7;
      } else if (cfg.type === 'wan') {
        baseColor = isThreat ? 0xfbbf24 : 0xa855f7;
        emissiveColor = isThreat ? 0xd97706 : 0x7e22ce;
      } else {
        baseColor = 0x22d3ee;
        emissiveColor = 0x0891b2;
      }

      const mat = new THREE.MeshStandardMaterial({
        color: baseColor,
        emissive: emissiveColor,
        emissiveIntensity: cfg.type === 'core' ? 0.7 : 0.35,
        roughness: 0.25,
        metalness: 0.7,
      });

      const mesh = new THREE.Mesh(sphereGeometry, mat);
      mesh.scale.setScalar(cfg.radius);
      mesh.position.set(...cfg.pos);
      mesh.userData = { id: cfg.id, role: cfg.role, defaultIp: cfg.defaultIp, type: cfg.type, index: idx };
      nodeGroup.add(mesh);

      // Subtle threat ring for core and elevated nodes
      let threatRing = null;
      if (cfg.type === 'core' || (isThreat && idx % 3 === 0)) {
        const ringMat = new THREE.MeshBasicMaterial({
          color: isCritical ? 0xf43f5e : isThreat ? 0xfbbf24 : 0x00e5ff,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.4,
        });
        threatRing = new THREE.Mesh(ringGeometry, ringMat);
        threatRing.rotation.x = Math.PI / 2;
        threatRing.scale.setScalar(cfg.radius * 1.5);
        mesh.add(threatRing);
      }

      createdNodes.push({
        mesh,
        cfg,
        mat,
        baseEmissive: cfg.type === 'core' ? 0.7 : 0.35,
        baseColor,
        threatRing,
        realIp: null,
        packetCount: 0,
        lastActivity: 0,
      });
    });

    nodesRef.current = createdNodes;

    // Structured Network Edges (Avoid unreadable spiderweb)
    const edgeIndices = [
      // Core Gateway to Servers
      [0, 1], [0, 2], [0, 3], [0, 4],
      // Server interconnections
      [1, 2], [2, 4], [3, 1],
      // Core Gateway to Internal Hosts
      [0, 5], [0, 6], [0, 7], [0, 8], [0, 9],
      // Servers to Hosts
      [1, 5], [2, 6], [3, 7], [4, 8], [1, 9],
      // Core Gateway to External Ingress
      [0, 10], [0, 11], [0, 12], [0, 13], [0, 14],
      // Edge connections
      [10, 1], [11, 2], [13, 4],
    ];

    const edgesGroup = new THREE.Group();
    scene.add(edgesGroup);

    const edgeObjects = edgeIndices.map(([srcIdx, dstIdx]) => {
      const p1 = createdNodes[srcIdx].mesh.position;
      const p2 = createdNodes[dstIdx].mesh.position;

      const edgeGeom = new THREE.BufferGeometry().setFromPoints([p1, p2]);
      const edgeMat = new THREE.LineBasicMaterial({
        color: isCritical ? 0xf43f5e : isThreat ? 0xfbbf24 : 0x00e5ff,
        transparent: true,
        opacity: isCritical ? 0.35 : isThreat ? 0.28 : 0.18,
      });

      const line = new THREE.Line(edgeGeom, edgeMat);
      edgesGroup.add(line);
      return { line, srcIdx, dstIdx, edgeMat };
    });

    // Dynamic 3D Packet Particle Meshes Pool
    const particleMeshPool = [];
    const maxMeshPool = 40;
    const particleMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });

    for (let i = 0; i < maxMeshPool; i++) {
      const pMesh = new THREE.Mesh(particleGeometry, particleMat.clone());
      pMesh.visible = false;
      scene.add(pMesh);
      particleMeshPool.push(pMesh);
    }

    // Interactive Raycasting on Node Click
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerDown = (e) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const meshes = createdNodes.map((n) => n.mesh);
      const intersects = raycaster.intersectObjects(meshes, false);

      if (intersects.length > 0) {
        const hitMesh = intersects[0].object;
        const matchedNode = createdNodes.find((n) => n.mesh === hitMesh);
        if (matchedNode) {
          setSelectedNode({
            id: matchedNode.cfg.id,
            role: matchedNode.cfg.role,
            ip: matchedNode.realIp || matchedNode.cfg.defaultIp,
            type: matchedNode.cfg.type,
            packets: matchedNode.packetCount,
            lastSeen: matchedNode.lastActivity ? new Date(matchedNode.lastActivity).toLocaleTimeString() : 'Active',
          });
        }
      } else {
        setSelectedNode(null);
      }
    };

    container.addEventListener('pointerdown', handlePointerDown);

    // Animation Loop
    let animId;
    const startTime = performance.now();
    let lastTime = startTime;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      
      const now = performance.now();
      const delta = (now - lastTime) / 1000;
      const elapsed = (now - startTime) / 1000;
      lastTime = now;

      // Controls update with damping
      controls.update();

      // Gentle floating drift (disabled when reduced-motion active)
      if (!prefersReducedMotion) {
        nodeGroup.rotation.y = Math.sin(elapsed * 0.15) * 0.08;
        edgesGroup.rotation.y = nodeGroup.rotation.y;

        // Core Pulse
        const coreNode = createdNodes[0];
        if (coreNode) {
          const coreScale = coreNode.cfg.radius * (1 + Math.sin(elapsed * 2.2) * 0.04);
          coreNode.mesh.scale.setScalar(coreScale);
          if (coreNode.threatRing) {
            coreNode.threatRing.rotation.z += 0.008;
          }
        }
      }

      // Smooth Node Emissive Decay (Real traffic reactive pulse)
      const currentTime = Date.now();
      createdNodes.forEach((node) => {
        const timeSinceActivity = currentTime - (node.lastActivity || 0);
        if (timeSinceActivity < 600) {
          // Temporarily highlight node on packet arrival
          const factor = 1 - timeSinceActivity / 600;
          node.mat.emissiveIntensity = THREE.MathUtils.lerp(node.baseEmissive, 1.4, factor);
        } else {
          node.mat.emissiveIntensity = THREE.MathUtils.lerp(node.mat.emissiveIntensity, node.baseEmissive, 0.1);
        }
      });

      // Animate REAL Data Packet Particles
      const activeParticles = activeParticlesRef.current;

      // Hide all meshes first
      particleMeshPool.forEach((m) => {
        m.visible = false;
      });

      for (let i = activeParticles.length - 1; i >= 0; i--) {
        const p = activeParticles[i];
        p.progress += p.speed;

        if (p.progress >= 1) {
          // Arrived at destination -> pulse destination node
          p.toNode.lastActivity = Date.now();
          activeParticles.splice(i, 1);
          continue;
        }

        if (i < maxMeshPool) {
          const pMesh = particleMeshPool[i];
          pMesh.visible = true;
          pMesh.position.lerpVectors(p.from, p.to, p.progress);
          pMesh.scale.setScalar(p.size);
          pMesh.material.color.setHex(p.color);
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    // Responsive Resize Observer
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const newWidth = entry.contentRect.width;
        const newHeight = entry.contentRect.height;
        if (newWidth > 0 && newHeight > 0) {
          camera.aspect = newWidth / newHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(newWidth, newHeight);
        }
      }
    });
    resizeObserver.observe(container);

    // Cleanup
    return () => {
      cancelAnimationFrame(animId);
      container.removeEventListener('pointerdown', handlePointerDown);
      resizeObserver.disconnect();
      controls.dispose();

      if (renderer.domElement && container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
      sphereGeometry.dispose();
      particleGeometry.dispose();
      ringGeometry.dispose();
      particleMat.dispose();
    };
  }, [isThreat, isCritical]);

  return (
    <div
      className="soc-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '420px',
        padding: '16px 20px',
        position: 'relative',
        overflow: 'hidden',
        background: 'linear-gradient(135deg, rgba(8, 13, 27, 0.96) 0%, rgba(13, 22, 45, 0.9) 100%)',
        border: '1px solid rgba(42, 57, 88, 0.8)',
        borderRadius: '16px',
        boxShadow: '0 16px 36px rgba(0, 0, 0, 0.5)',
      }}
    >
      {/* HUD Header */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '10px',
          zIndex: 10,
          pointerEvents: 'none',
        }}
      >
        <div className="soc-card-title-group" style={{ pointerEvents: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="soc-eyebrow" style={{ color: '#00e5ff', fontWeight: 800 }}>
              3D THREAT ENVIRONMENT
            </span>
            <span
              style={{
                fontSize: '9px',
                fontFamily: 'monospace',
                padding: '2px 6px',
                borderRadius: '4px',
                background: isCritical ? 'rgba(244, 63, 94, 0.2)' : isThreat ? 'rgba(251, 191, 36, 0.2)' : 'rgba(0, 229, 255, 0.12)',
                color: isCritical ? '#f43f5e' : isThreat ? '#fbbf24' : '#00e5ff',
                border: `1px solid ${isCritical ? '#f43f5e44' : isThreat ? '#fbbf2444' : '#00e5ff44'}`,
                fontWeight: 700,
              }}
            >
              REAL-TIME TOPOLOGY
            </span>
          </div>
          <h3 className="soc-card-title" style={{ margin: '2px 0 0 0', fontSize: '15px' }}>
            Network Topology &amp; State Constellation
          </h3>
        </div>

        {/* Status Badges & Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', pointerEvents: 'auto' }}>
          {/* Live Ingress Connection State */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              borderRadius: '6px',
              background: isStreaming ? 'rgba(0, 229, 255, 0.12)' : 'rgba(15, 23, 42, 0.8)',
              border: `1px solid ${isStreaming ? 'rgba(0, 229, 255, 0.3)' : 'rgba(51, 65, 85, 0.7)'}`,
              fontSize: '11px',
              fontFamily: 'monospace',
              color: isStreaming ? '#00e5ff' : '#94a3b8',
              fontWeight: 700,
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: isStreaming ? '#00e5ff' : '#64748b',
                boxShadow: isStreaming ? '0 0 8px #00e5ff' : 'none',
              }}
            />
            {isStreaming ? (isLive ? 'LIVE' : 'REPLAY') : 'WAITING FOR LIVE TRAFFIC'}
          </div>

          {/* Genuine Stream Packet Counter */}
          <span
            className="mono"
            style={{
              fontSize: '11px',
              padding: '4px 10px',
              borderRadius: '6px',
              background: 'rgba(15, 23, 42, 0.8)',
              color: '#e2e8f0',
              border: '1px solid rgba(51, 65, 85, 0.7)',
              fontWeight: 700,
            }}
          >
            {packetCount} Stream Pkts
          </span>

          {/* Reset Camera View Button */}
          <button
            onClick={() => resetCameraRef.current && resetCameraRef.current()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 8px',
              borderRadius: '6px',
              background: 'rgba(15, 23, 42, 0.9)',
              border: '1px solid rgba(51, 65, 85, 0.8)',
              color: '#94a3b8',
              fontSize: '11px',
              cursor: 'pointer',
            }}
            title="Reset Camera View"
          >
            <RotateCcw size={12} />
            <span style={{ fontSize: '10px', fontFamily: 'monospace' }}>Reset</span>
          </button>
        </div>
      </div>

      {/* 3D WebGL Canvas Container or Fallback */}
      {webglError ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#94a3b8',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
        >
          3D visualization unavailable — showing topology fallback.
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 1,
            cursor: 'grab',
          }}
        />
      )}

      {/* Selected Node Details Floating HUD Card */}
      {selectedNode && (
        <div
          style={{
            position: 'absolute',
            top: '70px',
            right: '20px',
            zIndex: 20,
            background: 'rgba(8, 13, 27, 0.94)',
            border: '1px solid rgba(0, 229, 255, 0.4)',
            borderRadius: '10px',
            padding: '12px 14px',
            minWidth: '220px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
            fontSize: '11px',
            fontFamily: 'monospace',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ color: '#00e5ff', fontWeight: 800 }}>NODE INSPECTOR</span>
            <button
              onClick={() => setSelectedNode(null)}
              style={{
                background: 'none',
                border: 'none',
                padding: '2px',
                color: '#64748b',
                cursor: 'pointer',
              }}
            >
              <X size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div>
              <span style={{ color: '#64748b' }}>ROLE: </span>
              <strong style={{ color: '#f1f5f9' }}>{selectedNode.role}</strong>
            </div>
            <div>
              <span style={{ color: '#64748b' }}>IP: </span>
              <strong style={{ color: '#38bdf8' }}>{selectedNode.ip}</strong>
            </div>
            <div>
              <span style={{ color: '#64748b' }}>PACKETS OBSERVED: </span>
              <strong style={{ color: '#f1f5f9' }}>{selectedNode.packets}</strong>
            </div>
            <div>
              <span style={{ color: '#64748b' }}>STATUS: </span>
              <span style={{ color: '#34d399', fontWeight: 700 }}>ONLINE</span>
            </div>
          </div>
        </div>
      )}

      {/* Floating HUD Footer */}
      <div
        style={{
          position: 'absolute',
          bottom: '12px',
          left: '20px',
          right: '20px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          zIndex: 10,
          pointerEvents: 'none',
          fontSize: '11px',
          color: '#64748b',
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span>TOPOLOGY: 3D ADAPTIVE MESH &middot; NODES: 15</span>
          <span style={{ color: '#334155' }}>|</span>
          <span>DRAG TO ROTATE &middot; SCROLL TO ZOOM</span>
        </div>

        <div>
          <span>
            ENGINE: <strong style={{ color: '#94a3b8' }}>{status?.mode ? status.mode.toUpperCase() : 'STANDBY'}</strong> &middot; STATES: <strong style={{ color: '#94a3b8' }}>{status?.state_count ?? 0}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
