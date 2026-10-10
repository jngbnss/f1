/**
 * Device-agnostic driving intent. Every input device (keyboard, gamepad,
 * mobile gyro, steering wheel, network controller) produces this shape.
 * Values are analog so digital and analog devices share one pipeline.
 */
export interface VehicleInput {
  /** 0..1 accelerator pedal. */
  throttle: number;
  /** 0..1 brake pedal (also reverses when nearly stopped). */
  brake: number;
  /** -1 (full left) .. +1 (full right). */
  steer: number;
  /** 0..1 handbrake. */
  handbrake: number;
}

/** One-shot actions (edge-triggered, consumed once per poll). */
export type InputAction = 'reset' | 'overtake';

export function emptyInput(): VehicleInput {
  return { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
}

export interface InputSource {
  readonly id: string;
  /** Current state of this device. Return null when the device is idle/disconnected. */
  read(): VehicleInput | null;
  /** Actions triggered since the last call. */
  consumeActions(): InputAction[];
  dispose(): void;
}
