import * as THREE from 'three';

/** What the steering wheel display shows (player car only). */
export interface DashState {
  gear: string;
  /** km/h */
  speed: number;
  /** 0..1 engine speed between idle and redline (drives the shift lights). */
  rpm: number;
  /** Last lap minus best lap (s); null before two timed laps. */
  delta: number | null;
  /** 0..100 battery state of charge. */
  battery: number;
  lap: number;
  totalLaps: number | null;
  /** Front-left tyre wear 0..1 shown as "M 14%". */
  tyreLabel: string;
}

const W = 0.27;
const H = 0.14;
const D = 0.03;
const CW = 540;
const CH = 280;
const LEDS = ['#18d14a', '#18d14a', '#18d14a', '#18d14a', '#18d14a', '#ff2a2a', '#ff2a2a', '#ff2a2a', '#ff2a2a', '#ff2a2a', '#2a6bff', '#2a6bff', '#2a6bff', '#2a6bff', '#2a6bff'];
/** Redraws at most this often (s); the canvas upload is the expensive part. */
const REDRAW = 1 / 15;

/**
 * 2026-style F1 steering wheel: carbon body with a live display (gear, speed,
 * lap delta, battery, lap), shift lights driven by rpm, coloured buttons and
 * rotaries, rubber grips either side. Faces +Z (the driver). The face canvas
 * is redrawn only when what it shows changes, at most 15 times a second.
 */
export class SteeringWheel {
  readonly group = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly background: HTMLCanvasElement;
  private lastKey = '';
  private lastDraw = -1;

  constructor(textures: THREE.Texture[], own: <T extends THREE.Material>(m: T) => T, geometries: THREE.BufferGeometry[]) {
    this.group.name = 'SteeringWheel';
    this.background = drawBackground();
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.g = this.canvas.getContext('2d')!;
    this.g.drawImage(this.background, 0, 0);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    textures.push(this.texture);
    this.draw({ gear: 'N', speed: 0, rpm: 0, delta: null, battery: 80, lap: 0, totalLaps: null, tyreLabel: 'M 0%' });

    const carbon = own(new THREE.MeshPhysicalMaterial({ color: 0x1a1c20, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.1 }));
    const faceMat = own(new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.45, emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 0.35 }));
    const rubber = own(new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.95 }));
    const boxGeo = new THREE.BoxGeometry(W, H, D);
    const gripGeo = new THREE.CapsuleGeometry(0.022, 0.1, 4, 10);
    const paddleGeo = new THREE.BoxGeometry(0.06, 0.07, 0.006);
    geometries.push(boxGeo, gripGeo, paddleGeo);
    // Box faces: +x, -x, +y, -y, +z (driver), -z.
    this.group.add(new THREE.Mesh(boxGeo, [carbon, carbon, carbon, carbon, faceMat, carbon]));
    for (const sx of [-1, 1]) {
      const grip = new THREE.Mesh(gripGeo, rubber);
      grip.position.set(sx * (W / 2 + 0.012), -0.01, -0.005);
      grip.rotation.z = sx * 0.12;
      this.group.add(grip);
      const paddle = new THREE.Mesh(paddleGeo, carbon);
      paddle.position.set(sx * 0.09, 0, -D / 2 - 0.012);
      this.group.add(paddle);
    }
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Called every frame for the player's car; redraws only on change, throttled. */
  setDash(s: DashState, now = performance.now() / 1000): void {
    if (now - this.lastDraw < REDRAW) return;
    const leds = Math.round(Math.max(0, Math.min(1, (s.rpm - 0.55) / 0.42)) * LEDS.length);
    const key = `${s.gear}|${Math.round(s.speed)}|${leds}|${s.delta?.toFixed(3)}|${Math.round(s.battery)}|${s.lap}|${s.tyreLabel}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastDraw = now;
    this.draw(s, leds);
  }

  private draw(s: DashState, leds = 0): void {
    const g = this.g;
    g.drawImage(this.background, 0, 0);
    // Shift lights: lit left to right; all flash blue at the limiter.
    const limiter = leds >= LEDS.length;
    LEDS.forEach((c, i) => {
      const on = i < leds && (!limiter || Math.floor(performance.now() / 80) % 2 === 0);
      g.fillStyle = on ? c : '#2a2d33';
      g.beginPath();
      g.arc(110 + i * 23, 22, 8, 0, Math.PI * 2);
      g.fill();
    });
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f5f5f5';
    g.font = '900 80px "Arial Black", Arial, sans-serif';
    g.fillText(s.gear, 270, 108);
    g.font = '800 26px Arial, sans-serif';
    g.fillText(String(Math.round(s.speed)), 270, 160);
    g.font = '700 20px Arial, sans-serif';
    if (s.delta !== null) {
      g.fillStyle = s.delta <= 0 ? '#18d14a' : '#ff4a3a';
      g.fillText(`${s.delta <= 0 ? '−' : '+'}${Math.abs(s.delta).toFixed(3)}`, 192, 66);
    } else {
      g.fillStyle = '#9aa3ad';
      g.fillText('--.---', 192, 66);
    }
    g.fillStyle = s.battery > 30 ? '#ffd200' : '#ff4a3a';
    g.fillText(`BAT ${Math.round(s.battery)}%`, 350, 66);
    g.fillStyle = '#9aa3ad';
    g.fillText(s.totalLaps ? `L ${s.lap}/${s.totalLaps}` : `LAP ${s.lap}`, 198, 158);
    g.fillText(s.tyreLabel, 340, 158);
    this.texture.needsUpdate = true;
  }
}

/** Static parts of the face: carbon weave, display bezel, buttons and rotaries. */
function drawBackground(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = CW;
  c.height = CH;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16181c';
  g.fillRect(0, 0, CW, CH);
  g.fillStyle = 'rgba(255,255,255,0.035)';
  for (let y = 0; y < CH; y += 6) for (let x = (y / 6) % 2 ? 0 : 6; x < CW; x += 12) g.fillRect(x, y, 6, 6);
  g.fillStyle = '#05070a';
  g.beginPath();
  g.roundRect(150, 48, 240, 128, 10);
  g.fill();
  g.strokeStyle = '#3a3f47';
  g.lineWidth = 4;
  g.stroke();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const button = (x: number, y: number, color: string, label: string) => {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, 17, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '700 13px Arial, sans-serif';
    g.fillText(label, x, y + 1);
  };
  button(110, 80, '#d0021b', 'PIT');
  button(110, 130, '#1f5fd6', 'BB');
  button(430, 80, '#f5b800', 'OT');
  button(430, 130, '#2a9d4a', 'RAD');
  button(205, 215, '#e8e8e8', 'N');
  button(335, 215, '#7a2cff', 'K');
  const rotary = (x: number, y: number) => {
    g.fillStyle = '#2c3036';
    g.beginPath();
    g.arc(x, y, 26, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ffd200';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 18, y - 14);
    g.stroke();
  };
  rotary(150, 220);
  rotary(270, 228);
  rotary(390, 220);
  return c;
}
