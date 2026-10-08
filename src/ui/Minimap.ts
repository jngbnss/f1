import type * as THREE from 'three';

export interface MinimapCar {
  position: THREE.Vector3;
  color: number;
  isPlayer: boolean;
}

const SIZE = 200;
const PAD = 14;
/** Redraws per second (cars move little between frames; saves canvas work). */
const RATE = 20;

/**
 * North-up track map in a corner: circuit outline (drawn once into a cached
 * canvas), start line, and a dot per car (player larger, outlined).
 */
export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly scale: number;
  private readonly ox: number;
  private readonly oz: number;
  private readonly dpr: number;
  private lastDraw = 0;

  constructor(centerline: readonly THREE.Vector3[], parent: HTMLElement = document.body) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of centerline) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    this.scale = (SIZE - PAD * 2) / span;
    // Center the circuit in the square.
    this.ox = PAD + (SIZE - PAD * 2 - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.oz = PAD + (SIZE - PAD * 2 - (maxZ - minZ) * this.scale) / 2 - minZ * this.scale;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    this.canvas.width = this.canvas.height = SIZE * this.dpr;
    this.canvas.style.width = this.canvas.style.height = `${SIZE}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.base = this.drawBase(centerline);
    parent.appendChild(this.canvas);
  }

  update(cars: readonly MinimapCar[], now = performance.now()): void {
    if (now - this.lastDraw < 1000 / RATE) return;
    this.lastDraw = now;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Opponents first, player on top.
    for (const pass of [false, true]) {
      for (const c of cars) {
        if (c.isPlayer !== pass) continue;
        const x = this.ox + c.position.x * this.scale;
        const y = this.oz + c.position.z * this.scale;
        g.beginPath();
        g.arc(x, y, c.isPlayer ? 5 : 3.2, 0, Math.PI * 2);
        g.fillStyle = `#${c.color.toString(16).padStart(6, '0')}`;
        g.fill();
        g.lineWidth = c.isPlayer ? 2 : 1;
        g.strokeStyle = c.isPlayer ? '#ffffff' : 'rgba(0,0,0,0.6)';
        g.stroke();
      }
    }
  }

  dispose(): void {
    this.canvas.remove();
  }

  private drawBase(line: readonly THREE.Vector3[]): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = SIZE * this.dpr;
    const g = c.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    const path = () => {
      g.beginPath();
      line.forEach((p, i) => {
        const x = this.ox + p.x * this.scale;
        const y = this.oz + p.z * this.scale;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.closePath();
    };
    g.lineJoin = 'round';
    path();
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 7;
    g.stroke();
    path();
    g.strokeStyle = '#e8edf2';
    g.lineWidth = 3;
    g.stroke();
    // Start/finish: short bar across the track at the first sample.
    const a = line[0];
    const b = line[1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const x = this.ox + a.x * this.scale;
    const y = this.oz + a.z * this.scale;
    g.beginPath();
    g.moveTo(x - (dz / len) * 6, y + (dx / len) * 6);
    g.lineTo(x + (dz / len) * 6, y - (dx / len) * 6);
    g.strokeStyle = '#ff3b30';
    g.lineWidth = 3;
    g.stroke();
    return c;
  }
}
