import type { HandInput } from '../input/HandInput';
import { palmCenter } from '../input/handFeatures';

const W = 200;

/**
 * Small selfie view of the webcam with the tracked hands drawn on it, plus
 * the steering/brake the hands produce — so the player can see what the
 * camera sees and correct their pose.
 */
export class HandPreview {
  private readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly label = document.createElement('div');
  private raf = 0;

  constructor(private readonly hand: HandInput) {
    this.root.className = 'hand-preview';
    this.label.className = 'hand-preview-label';
    this.root.append(this.canvas, this.label);
    document.body.append(this.root);
    this.raf = requestAnimationFrame(this.draw);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
  }

  private draw = (): void => {
    this.raf = requestAnimationFrame(this.draw);
    const { hand, canvas } = this;
    const h = Math.round(W / hand.aspect);
    if (canvas.width !== W || canvas.height !== h) {
      canvas.width = W;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Mirrored, like a selfie: matches the view space of the landmarks.
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(hand.video, 0, 0, W, h);
    ctx.restore();

    // Landmarks are in [0, aspect] x [0, 1].
    const sx = W / hand.aspect;
    const sy = h;
    const centers = hand.hands.map(palmCenter);
    if (centers.length >= 2) {
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(centers[0].x * sx, centers[0].y * sy);
      ctx.lineTo(centers[1].x * sx, centers[1].y * sy);
      ctx.stroke();
    }
    ctx.fillStyle = hand.brake > 0 ? '#ff4d4d' : '#4dff88';
    for (const lm of hand.hands) {
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * sx, p.y * sy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.label.textContent = hand.tracking
      ? `조향 ${Math.round(hand.steer * 100)}% · 브레이크 ${Math.round(hand.brake * 100)}%`
      : '손이 안 보여요';
    this.label.classList.toggle('lost', !hand.tracking);
  };
}
