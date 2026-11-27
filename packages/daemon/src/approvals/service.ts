/**
 * オーナーのパスキーで承認する仕組み（5.8 の2・3）と、承認アプリの端末をまとめたもの。
 * ローカルAPI の道（`api/routes/approvals.ts`）から使う。状態（ペアリング・ログインのチャレンジ・
 * セッション・出してあった payload）は daemon のメモリの中にだけ持つ。
 */
import type { AuditActor } from "@aicoop/shared";
import type { DeviceView } from "@aicoop/shared/api";
import type { ApprovalContext } from "./context.ts";
import {
  type Device,
  DeviceError,
  getActiveDevice,
  listDevices,
  revokeDevice,
  toDeviceView,
} from "./devices.ts";
import { ApprovalFailure } from "./errors.ts";
import { createLogin, type Login } from "./login.ts";
import { createPairing, type PairingManager } from "./pairing.ts";
import { createSessionStore } from "./sessions.ts";
import { createSigner, type Signer } from "./sign.ts";
import type { ApprovalTargets } from "./types.ts";

export interface ApprovalServiceOptions extends ApprovalContext {
  /** 承認される対象（保留・一時権限など）。読むたびに呼ぶ */
  readonly targets: () => ApprovalTargets;
}

export interface LoggedIn {
  readonly device: Device;
  readonly expiresAt: Date;
}

export interface ApprovalService {
  readonly pairing: PairingManager;
  readonly login: Login;
  readonly signer: Signer;
  /** クッキーの値から、ログイン中の端末（有効なものだけ）を返す */
  sessionFor(token: string | undefined): LoggedIn | undefined;
  logout(token: string): void;
  listDevices(): DeviceView[];
  /** 端末を取り消す。その端末のセッションと、出してあった payload もすぐ捨てる（T-12） */
  revokeDevice(id: string, by: AuditActor): DeviceView;
  /** 動いている afterApply を待つ（daemon を止めるとき） */
  drain(): Promise<void>;
}

export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
  const { db, logger } = options;
  const sessions = createSessionStore(options.now);
  const pairing = createPairing(options);
  const login = createLogin(options, sessions);
  const signer = createSigner(options, options.targets);

  return {
    pairing,
    login,
    signer,
    sessionFor(token) {
      const session = sessions.resolve(token);
      if (session === undefined) return undefined;
      const device = getActiveDevice(db, session.deviceId);
      if (device === undefined) {
        sessions.removeDevice(session.deviceId);
        return undefined;
      }
      return { device, expiresAt: session.expiresAt };
    },
    logout(token) {
      sessions.remove(token);
    },
    listDevices: () => listDevices(db).map(toDeviceView),
    revokeDevice(id, by) {
      let device: Device;
      try {
        device = revokeDevice(db, id, by);
      } catch (error) {
        if (error instanceof DeviceError) {
          throw error.code === "not_found"
            ? new ApprovalFailure(404, "not_found", error.message)
            : new ApprovalFailure(409, "invalid_state", error.message);
        }
        throw error;
      }
      const removed = sessions.removeDevice(id);
      signer.forgetDevice(id);
      logger.info({ device_id: id, sessions: removed, by }, "端末を取り消しました");
      return toDeviceView(device);
    },
    drain: () => signer.drain(),
  };
}
