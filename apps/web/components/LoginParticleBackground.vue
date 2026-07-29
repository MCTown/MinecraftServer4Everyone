<script setup lang="ts">
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineSegments,
  MathUtils,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer
} from "three";

const canvas = ref<HTMLCanvasElement | null>(null);
let cleanup: (() => void) | undefined;

onMounted(() => {
  if (!canvas.value || typeof window === "undefined") return;

  const element = canvas.value;
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 1, 300);
  camera.position.z = 100;

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas: element, alpha: true, antialias: true });
  } catch {
    return;
  }

  const initialWidth = window.innerWidth;
  const initialHeight = window.innerHeight;
  const particleCount = Math.min(900, Math.max(420, Math.floor((initialWidth * initialHeight) / 2600)));
  const base = new Float32Array(particleCount * 3);
  const positions = new Float32Array(particleCount * 3);
  const wander = new Float32Array(particleCount * 3);
  const phases = new Float32Array(particleCount);
  const speeds = new Float32Array(particleCount);
  const velocityX = new Float32Array(particleCount);
  const velocityY = new Float32Array(particleCount);
  const targetVelocityX = new Float32Array(particleCount);
  const targetVelocityY = new Float32Array(particleCount);
  const nextTurn = new Float64Array(particleCount);
  const colors = new Float32Array(particleCount * 3);
  const palette = [new Color("#91b6c9"), new Color("#8cbca9"), new Color("#e6aa64")];

  for (let index = 0; index < particleCount; index += 1) {
    const offset = index * 3;
    const depth = Math.random() * 30 - 15;
    base[offset] = Math.random() * 2 - 1;
    base[offset + 1] = Math.random() * 2 - 1;
    base[offset + 2] = depth;
    positions[offset] = base[offset]!;
    positions[offset + 1] = base[offset + 1]!;
    positions[offset + 2] = depth;
    wander[offset] = base[offset]!;
    wander[offset + 1] = base[offset + 1]!;
    wander[offset + 2] = depth;
    phases[index] = Math.random() * Math.PI * 2;
    speeds[index] = 0.12 + Math.random() * 0.24;
    velocityX[index] = (Math.random() - 0.5) * 0.06;
    velocityY[index] = (Math.random() - 0.5) * 0.06;
    targetVelocityX[index] = velocityX[index]!;
    targetVelocityY[index] = velocityY[index]!;
    nextTurn[index] = performance.now() + Math.random() * 1800;

    const color = palette[index % palette.length]!;
    colors[offset] = color.r;
    colors[offset + 1] = color.g;
    colors[offset + 2] = color.b;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setAttribute("aPhase", new Float32BufferAttribute(phases, 1));
  geometry.setAttribute("aSpeed", new Float32BufferAttribute(speeds, 1));

  const material = new ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1 },
      uSize: { value: 1.5 },
      uTime: { value: 0 }
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSpeed;
      attribute vec3 color;
      uniform float uPixelRatio;
      uniform float uSize;
      uniform float uTime;
      varying vec3 vColor;
      varying float vPulse;

      void main() {
        vec4 modelViewPosition = modelViewMatrix * vec4(position, 1.0);
        vPulse = 0.5 + 0.5 * sin(uTime * (1.1 + aSpeed * 1.8) + aPhase);
        gl_PointSize = uSize * (0.78 + vPulse * 0.34) * uPixelRatio * (260.0 / max(-modelViewPosition.z, 1.0));
        gl_Position = projectionMatrix * modelViewPosition;
        vColor = color;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vPulse;

      void main() {
        float distanceFromCenter = length(gl_PointCoord - vec2(0.5));
        float circle = 1.0 - smoothstep(0.38, 0.5, distanceFromCenter);
        if (circle <= 0.01) discard;
        float brightness = 0.72 + vPulse * 0.45;
        gl_FragColor = vec4(vColor * brightness, circle * (0.58 + vPulse * 0.32));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending
  });
  const points = new Points(geometry, material);
  scene.add(points);

  const networkCount = Math.min(particleCount, initialWidth < 700 ? 150 : 240);
  const networkIndices: number[] = [];
  for (let index = 0; index < networkCount; index += 1) {
    networkIndices.push(Math.floor((index / networkCount) * particleCount));
  }

  function distanceBetweenParticles(first: number, second: number) {
    const firstOffset = first * 3;
    const secondOffset = second * 3;
    return Math.hypot(
      base[firstOffset]! - base[secondOffset]!,
      base[firstOffset + 1]! - base[secondOffset + 1]!
    );
  }

  const triangles: [number, number, number][] = [];
  const triangleKeys = new Set<string>();
  for (const source of networkIndices) {
    const neighbors = networkIndices
      .filter((candidate) => candidate !== source)
      .map((candidate) => ({ candidate, distance: distanceBetweenParticles(source, candidate) }))
      .sort((first, second) => first.distance - second.distance)
      .slice(0, 7)
      .map(({ candidate }) => candidate);

    for (let firstIndex = 0; firstIndex < neighbors.length - 1; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < neighbors.length; secondIndex += 1) {
        const first = neighbors[firstIndex]!;
        const second = neighbors[secondIndex]!;
        const maxDistance = Math.max(
          distanceBetweenParticles(source, first),
          distanceBetweenParticles(source, second),
          distanceBetweenParticles(first, second)
        );
        const firstOffset = first * 3;
        const secondOffset = second * 3;
        const sourceOffset = source * 3;
        const area = Math.abs(
          (base[firstOffset]! - base[sourceOffset]!) * (base[secondOffset + 1]! - base[sourceOffset + 1]!) -
            (base[firstOffset + 1]! - base[sourceOffset + 1]!) * (base[secondOffset]! - base[sourceOffset]!)
        );
        const sorted = [source, first, second].sort((a, b) => a - b) as [number, number, number];
        const key = sorted.join(":");

        if (maxDistance < 0.7 && area > 0.012 && !triangleKeys.has(key)) {
          triangleKeys.add(key);
          triangles.push(sorted);
        }
      }
    }
  }

  const edgeTriangleMap = new Map<string, number[]>();
  triangles.forEach(([first, second, third], triangleIndex) => {
    const keys = [
      `${Math.min(first, second)}:${Math.max(first, second)}`,
      `${Math.min(second, third)}:${Math.max(second, third)}`,
      `${Math.min(third, first)}:${Math.max(third, first)}`
    ];

    for (const key of keys) {
      const triangleIndices = edgeTriangleMap.get(key) || [];
      triangleIndices.push(triangleIndex);
      edgeTriangleMap.set(key, triangleIndices);
    }
  });
  const edgePairs = Array.from(edgeTriangleMap.keys(), (key) => key.split(":").map(Number) as [number, number]);
  const edgeTriangleIndices = edgePairs.map(([first, second]) =>
    edgeTriangleMap.get(`${first}:${second}`) || []
  );
  const connectionPositions = new Float32Array(edgePairs.length * 6);
  const connectionColors = new Float32Array(edgePairs.length * 6);
  const connectionGeometry = new BufferGeometry();
  connectionGeometry.setAttribute("position", new Float32BufferAttribute(connectionPositions, 3));
  connectionGeometry.setAttribute("color", new Float32BufferAttribute(connectionColors, 3));
  const connectionMaterial = new ShaderMaterial({
    vertexShader: `
      attribute vec3 color;
      varying vec3 vColor;

      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;

      void main() {
        float strength = max(max(vColor.r, vColor.g), vColor.b);
        if (strength < 0.01) discard;
        gl_FragColor = vec4(vColor, min(strength * 0.72, 0.92));
      }
    `,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true
  });
  const connections = new LineSegments(connectionGeometry, connectionMaterial);
  scene.add(connections);
  const edgeStrengths = edgePairs.map((_, index) => 0.16 + ((index * 37) % 100) / 100 * 0.24);
  const edgeColors = edgePairs.map(([first, second]) => palette[(first + second) % palette.length]!);

  const pointer = new Vector2();
  const pointerTarget = new Vector2();
  let animationFrame = 0;
  let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let pointerActive = false;
  let connectionVisibility = 0;
  let lastMotionTime = 0;

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pixelRatio);
    material.uniforms.uPixelRatio!.value = pixelRatio;
    renderer.setSize(width, height, false);
    renderScene(performance.now());
  }

  function renderScene(time: number) {
    const elapsed = time * 0.001;
    const delta = lastMotionTime ? Math.min((time - lastMotionTime) * 0.001, 0.05) : 0;
    lastMotionTime = time;
    const viewportHeight = 2 * Math.tan(MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    const viewportWidth = viewportHeight * camera.aspect;
    const pointerX = pointer.x * viewportWidth * 0.5;
    const pointerY = pointer.y * viewportHeight * 0.5;
    const interactionRadius = Math.min(viewportWidth, viewportHeight) * 0.24;
    const positionAttribute = geometry.getAttribute("position") as Float32BufferAttribute;

    for (let index = 0; index < particleCount; index += 1) {
      const offset = index * 3;
      const depthScale = 1 - base[offset + 2]! / 80;
      if (!reducedMotion && time >= nextTurn[index]!) {
        targetVelocityX[index] = (Math.random() - 0.5) * 0.075;
        targetVelocityY[index] = (Math.random() - 0.5) * 0.075;
        nextTurn[index] = time + 900 + Math.random() * 1900;
      }

      if (!reducedMotion) {
        velocityX[index]! += (targetVelocityX[index]! - velocityX[index]!) * Math.min(delta * 1.4, 1);
        velocityY[index]! += (targetVelocityY[index]! - velocityY[index]!) * Math.min(delta * 1.4, 1);
        wander[offset]! += velocityX[index]! * delta;
        wander[offset + 1]! += velocityY[index]! * delta;

        if (Math.abs(wander[offset]!) > 1.05) {
          wander[offset] = MathUtils.clamp(wander[offset]!, -1.05, 1.05);
          velocityX[index]! *= -0.8;
          targetVelocityX[index]! *= -1;
        }
        if (Math.abs(wander[offset + 1]!) > 1.05) {
          wander[offset + 1] = MathUtils.clamp(wander[offset + 1]!, -1.05, 1.05);
          velocityY[index]! *= -0.8;
          targetVelocityY[index]! *= -1;
        }
      }

      const targetX = wander[offset]! * viewportWidth * 0.44;
      const targetY = wander[offset + 1]! * viewportHeight * 0.48;
      const dx = targetX - pointerX;
      const dy = targetY - pointerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const influence = Math.max(0, 1 - distance / interactionRadius);
      const push = influence * influence * 5.5 * depthScale;

      positionAttribute.array[offset] = targetX + (dx / Math.max(distance, 1)) * push;
      positionAttribute.array[offset + 1] = targetY + (dy / Math.max(distance, 1)) * push;
      positionAttribute.array[offset + 2] = base[offset + 2]! + influence * 3;
    }

    positionAttribute.needsUpdate = true;
    material.uniforms.uTime!.value = elapsed;

    const connectionPositionAttribute = connectionGeometry.getAttribute("position") as Float32BufferAttribute;
    const connectionColorAttribute = connectionGeometry.getAttribute("color") as Float32BufferAttribute;
    connectionVisibility = MathUtils.lerp(connectionVisibility, pointerActive ? 1 : 0, reducedMotion ? 1 : 0.12);
    const triangleGlows = new Float32Array(triangles.length);
    const particleHoverRadius = Math.min(viewportWidth, viewportHeight) * 0.075;

    function pointInTriangle(
      pointX: number,
      pointY: number,
      firstX: number,
      firstY: number,
      secondX: number,
      secondY: number,
      thirdX: number,
      thirdY: number
    ) {
      const sign = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
        (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
      const firstSign = sign(pointX, pointY, firstX, firstY, secondX, secondY);
      const secondSign = sign(pointX, pointY, secondX, secondY, thirdX, thirdY);
      const thirdSign = sign(pointX, pointY, thirdX, thirdY, firstX, firstY);
      const hasNegative = firstSign < 0 || secondSign < 0 || thirdSign < 0;
      const hasPositive = firstSign > 0 || secondSign > 0 || thirdSign > 0;
      return !(hasNegative && hasPositive);
    }

    triangles.forEach(([first, second, third], triangleIndex) => {
      const firstOffset = first * 3;
      const secondOffset = second * 3;
      const thirdOffset = third * 3;
      const firstX = positionAttribute.array[firstOffset]!;
      const firstY = positionAttribute.array[firstOffset + 1]!;
      const secondX = positionAttribute.array[secondOffset]!;
      const secondY = positionAttribute.array[secondOffset + 1]!;
      const thirdX = positionAttribute.array[thirdOffset]!;
      const thirdY = positionAttribute.array[thirdOffset + 1]!;
      const vertexGlow = Math.max(
        Math.max(0, 1 - Math.hypot(firstX - pointerX, firstY - pointerY) / particleHoverRadius),
        Math.max(0, 1 - Math.hypot(secondX - pointerX, secondY - pointerY) / particleHoverRadius),
        Math.max(0, 1 - Math.hypot(thirdX - pointerX, thirdY - pointerY) / particleHoverRadius)
      );
      const insideTriangle = pointInTriangle(
        pointerX,
        pointerY,
        firstX,
        firstY,
        secondX,
        secondY,
        thirdX,
        thirdY
      );
      triangleGlows[triangleIndex] = pointerActive ? Math.max(vertexGlow, insideTriangle ? 0.72 : 0) : 0;
    });

    edgePairs.forEach(([first, second], edgeIndex) => {
      const firstOffset = first * 3;
      const secondOffset = second * 3;
      const edgeOffset = edgeIndex * 6;
      const firstX = positionAttribute.array[firstOffset]!;
      const firstY = positionAttribute.array[firstOffset + 1]!;
      const firstZ = positionAttribute.array[firstOffset + 2]!;
      const secondX = positionAttribute.array[secondOffset]!;
      const secondY = positionAttribute.array[secondOffset + 1]!;
      const secondZ = positionAttribute.array[secondOffset + 2]!;

      connectionPositionAttribute.array[edgeOffset] = firstX;
      connectionPositionAttribute.array[edgeOffset + 1] = firstY;
      connectionPositionAttribute.array[edgeOffset + 2] = firstZ;
      connectionPositionAttribute.array[edgeOffset + 3] = secondX;
      connectionPositionAttribute.array[edgeOffset + 4] = secondY;
      connectionPositionAttribute.array[edgeOffset + 5] = secondZ;

      const pulse = 0.5 + 0.5 * Math.sin(elapsed * (0.7 + (edgeIndex % 5) * 0.08) + edgeIndex * 0.9);
      const localGlow = Math.max(...(edgeTriangleIndices[edgeIndex] || []).map((triangleIndex) => triangleGlows[triangleIndex]!));
      const intensity = connectionVisibility * localGlow * Math.min(
        1.8,
        edgeStrengths[edgeIndex]! * 1.25 + pulse * 0.18 + localGlow * 1.2
      );
      const color = edgeColors[edgeIndex]!;

      for (const offset of [edgeOffset, edgeOffset + 3]) {
        connectionColorAttribute.array[offset] = color.r * intensity;
        connectionColorAttribute.array[offset + 1] = color.g * intensity;
        connectionColorAttribute.array[offset + 2] = color.b * intensity;
      }
    });

    connectionPositionAttribute.needsUpdate = true;
    connectionColorAttribute.needsUpdate = true;
    points.rotation.z = Math.sin(elapsed * 0.08) * 0.025 + pointer.x * 0.018;
    points.rotation.x = pointer.y * -0.018;
    connections.rotation.copy(points.rotation);
    renderer.render(scene, camera);
  }

  function animate(time: number) {
    pointer.lerp(pointerTarget, reducedMotion ? 1 : 0.055);
    renderScene(time);
    animationFrame = window.requestAnimationFrame(animate);
  }

  function onPointerMove(event: PointerEvent) {
    pointerActive = true;
    pointerTarget.set(
      MathUtils.clamp((event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1, -1, 1),
      MathUtils.clamp(1 - (event.clientY / Math.max(window.innerHeight, 1)) * 2, -1, 1)
    );
    if (reducedMotion) renderScene(performance.now());
  }

  function onPointerLeave() {
    pointerActive = false;
    pointerTarget.set(0, 0);
    if (reducedMotion) renderScene(performance.now());
  }

  function onMotionPreferenceChange(event: MediaQueryListEvent) {
    reducedMotion = event.matches;
    if (reducedMotion) {
      window.cancelAnimationFrame(animationFrame);
      renderScene(performance.now());
    } else {
      animationFrame = window.requestAnimationFrame(animate);
    }
  }

  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave);
  motionPreference.addEventListener("change", onMotionPreferenceChange);
  resize();

  if (reducedMotion) {
    renderScene(performance.now());
  } else {
    animationFrame = window.requestAnimationFrame(animate);
  }

  cleanup = () => {
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerleave", onPointerLeave);
    motionPreference.removeEventListener("change", onMotionPreferenceChange);
    geometry.dispose();
    connectionGeometry.dispose();
    material.dispose();
    connectionMaterial.dispose();
    renderer.dispose();
  };
});

onBeforeUnmount(() => {
  cleanup?.();
  cleanup = undefined;
});
</script>

<template>
  <canvas ref="canvas" class="login-particle-background" aria-hidden="true" />
</template>

<style scoped>
.login-particle-background {
  position: fixed;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
