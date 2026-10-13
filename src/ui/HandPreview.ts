import type { HandInput } from '../input/HandInput';
import { palmCenter } from '../input/handFeatures';

/** Displayed width (CSS px): small enough to stay out of the way of the road. */
const CSS_W = 176;

/**
 * Small selfie view of the webcam at the bottom centre with the tracked hands
 * and face drawn on it, plus the steering/brake the hands produce — so the
 * player can see what the camera sees and correct their pose.
 */
export class HandPreview {
  private readonly root = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly label = document.createElement('div');
  private raf = 0;
  private lastVideoTime = -1;
  private lastLabel = '';

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
    // Nothing new to show until the camera delivers a frame.
    if (hand.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = hand.video.currentTime;
    // Backing store in device pixels (sharp on HiDPI), at a fixed CSS size (no layout reads).
    const px = window.devicePixelRatio || 1;
    const W = Math.round(CSS_W * px);
    const h = Math.round(W / hand.aspect);
    if (canvas.width !== W || canvas.height !== h) {
      canvas.width = W;
      canvas.height = h;
      canvas.style.width = `${CSS_W}px`;
      canvas.style.height = `${Math.round(CSS_W / hand.aspect)}px`;
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
    // The face: hands on the head (left = reset, right = pit) are measured against it.
    if (hand.face) {
      const f = hand.face;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.lineWidth = 1.5 * px;
      ctx.strokeRect(f.x0 * sx, f.y0 * sy, (f.x1 - f.x0) * sx, (f.y1 - f.y0) * sy);
    }
    const centers = hand.hands.map(palmCenter);
    if (centers.length >= 2) {
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.moveTo(centers[0].x * sx, centers[0].y * sy);
      ctx.lineTo(centers[1].x * sx, centers[1].y * sy);
      ctx.stroke();
    }
    ctx.fillStyle = hand.brake > 0 ? '#ff4d4d' : '#4dff88';
    for (const lm of hand.hands) {
      for (const p of lm) {
        ctx.beginPath();
        ctx.arc(p.x * sx, p.y * sy, 2 * px, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const text = !hand.tracking
      ? '손이 안 보여요'
      : hand.choosingTyre
        ? `타이어 선택: 손가락 ${hand.fingers}개`
        : `조향 ${Math.round(hand.steer * 100)}% · 브레이크 ${Math.round(hand.brake * 100)}%`;
    if (text === this.lastLabel) return;
    this.lastLabel = text;
    this.label.textContent = text;
    this.label.classList.toggle('lost', !hand.tracking);
    this.label.classList.toggle('tyre', hand.tracking && hand.choosingTyre);
  };
}
