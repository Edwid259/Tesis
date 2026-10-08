/**
 * Port fiel de `Codigos/odrive-controller/src/odrive_virtual.cpp`.
 *
 * Es un reemplazo directo del driver ODrive S1: simula inercia rotacional, rampa de aceleración y
 * frenado, corriente de carga hidrodinámica cuadrática con la velocidad, corriente dinámica de
 * aceleración, caída del bus DC por resistencia interna, potencia, torque estimado y temperatura de
 * los FET, además de la máquina de estados de armado.
 *
 * Cada fórmula conserva la forma EXACTA del original; sólo se sustituye `millis()` por un `nowMs`
 * inyectado para que el modelo sea reproducible y testeable fuera del MCU.
 *
 * Diferencias deliberadas (documentadas, no accidentales):
 *  1. `VIRTUAL_VBUS_NOMINAL` usa 12 V (el banco real) en vez de los 24 V del env virtual del
 *     firmware. Es parametrizable.
 *  2. `dt` se recorta igual que el original, pero el gemelo recibe el tiempo del runner.
 */
const { odrive: C, odriveModel: M } = require('./constants');

class ODriveVirtual {
  constructor({ nominalVbus = C.VIRTUAL_VBUS_NOMINAL, rampRateRpmPerSec = C.VIRTUAL_RAMP_RPM_PER_S } = {}) {
    this._nominalVbus = nominalVbus;
    this._rampRate = rampRateRpmPerSec;
    this._targetRpm = 0;
    this._actualRpm = 0;
    this._vbus = nominalVbus;
    this._ibus = C.VIRTUAL_IBUS_IDLE;
    this._power = 0;
    this._state = M.STATE_IDLE;      // AXIS_STATE_IDLE
    this._controlMode = 2;           // VELOCITY_CONTROL
    this._inputMode = 2;             // VEL_RAMP
    this._axisError = 0;
    this._isArmed = false;
    this._lastUpdateMs = 0;
  }

  begin() {
    this._state = M.STATE_IDLE;
    this._isArmed = false;
    this._axisError = 0;
    this._targetRpm = 0;
    this._actualRpm = 0;
    this._vbus = this._nominalVbus;
    this._ibus = C.VIRTUAL_IBUS_IDLE;
    this._power = this._vbus * this._ibus;
    this._lastUpdateMs = 0;
    return true;
  }

  /** `setVelocityRpm` — sólo acepta consigna si está armado y en CLOSED_LOOP_CONTROL. */
  setVelocityRpm(rpm) {
    if (!this._isArmed || this._state !== M.STATE_CLOSED_LOOP) {
      this._targetRpm = 0;
      return true;
    }
    this._targetRpm = Math.min(C.MAX_MOTOR_RPM, Math.max(C.MIN_MOTOR_RPM, rpm));
    return true;
  }

  requestState(state) {
    this._state = state;
    this._isArmed = state === M.STATE_CLOSED_LOOP;
    if (!this._isArmed) this._targetRpm = 0;
    return true;
  }

  enterClosedLoop() {
    this.clearErrors();
    this._state = M.STATE_CLOSED_LOOP;
    this._isArmed = true;
    return true;
  }

  enterIdle() {
    this._state = M.STATE_IDLE;
    this._isArmed = false;
    this._targetRpm = 0;
    return true;
  }

  clearErrors() {
    this._axisError = 0;
    return true;
  }

  setSimulatedError(errorCode) {
    this._axisError = errorCode;
    if (errorCode !== 0) this.enterIdle();
  }

  setNominalVbus(v) { this._nominalVbus = v; }

  setRampRate(rpmPerSec) { if (rpmPerSec > 10.0) this._rampRate = rpmPerSec; }

  /**
   * `updatePhysics` — paso de integración del modelo.
   * Orden idéntico al original: inercia -> corriente de carga -> corriente de aceleración ->
   * caída de bus -> potencia.
   */
  updatePhysics(nowMs) {
    if (this._lastUpdateMs === 0) {
      this._lastUpdateMs = nowMs;
      return;
    }

    let dt = (nowMs - this._lastUpdateMs) / 1000.0;
    this._lastUpdateMs = nowMs;

    if (dt <= 0) return;
    if (dt > M.DT_CLAMP_S) dt = M.DT_CLAMP_S;

    const prevRpm = this._actualRpm;

    // 1. Aceleración/desaceleración inercial hacia la consigna
    if (!this._isArmed || this._state !== M.STATE_CLOSED_LOOP) {
      // Coast down cuando está desarmado / en IDLE
      const coastRamp = this._rampRate * M.COAST_RAMP_FACTOR * dt;
      this._actualRpm = this._actualRpm > coastRamp ? this._actualRpm - coastRamp : 0;
    } else {
      const maxDelta = this._rampRate * dt;
      if (this._targetRpm > this._actualRpm) {
        this._actualRpm = Math.min(this._actualRpm + maxDelta, this._targetRpm);
      } else if (this._targetRpm < this._actualRpm) {
        this._actualRpm = Math.max(this._actualRpm - maxDelta, this._targetRpm);
      }
    }

    // 2. Corriente de carga realista y caída de tensión.
    // Carga hidrodinámica de la pala en agua: cuadrática con la velocidad.
    const normSpeed = this._actualRpm / C.MAX_MOTOR_RPM;
    const loadCurrent = C.VIRTUAL_IBUS_MAX_LOAD * (normSpeed * normSpeed);

    // Corriente dinámica de aceleración
    const dRpmDt = Math.abs(this._actualRpm - prevRpm) / dt;
    const accelCurrent = dRpmDt * M.ACCEL_CURRENT_COEF;

    this._ibus = C.VIRTUAL_IBUS_IDLE + loadCurrent + accelCurrent;

    // Caída del bus DC por resistencia interna: Vbus = Vnom - (Rint * Ibus)
    this._vbus = this._nominalVbus - (this._ibus * M.BUS_INTERNAL_R_OHM);
    this._power = this._vbus * this._ibus;
  }

  /** `pollTelemetry` — snapshot en la forma que espera `ODriveTelemetry`. */
  pollTelemetry(nowMs) {
    this.updatePhysics(nowMs);

    const omegaRadS = (this._actualRpm * 2.0 * Math.PI) / 60.0;
    const torque = omegaRadS > M.TORQUE_OMEGA_MIN ? this._power / omegaRadS : 0.0;

    return {
      vbus_voltage: this._vbus,
      ibus_current: this._ibus,
      actual_rpm: this._actualRpm,
      power_watts: this._power,
      torque_estimate: torque,
      fet_temperature: M.FET_TEMP_BASE_C + (this._ibus * M.FET_TEMP_PER_AMP),
      axis_error: this._axisError,
      disarm_reason: (this._state === M.STATE_IDLE && !this._isArmed) ? 1 : 0,
      current_state: this._state,
      control_mode: this._controlMode,
      input_mode: this._inputMode,
      is_armed: this._isArmed
    };
  }

  /** Acceso sólo-lectura al estado interno (para aserciones del banco). */
  get state() {
    return {
      targetRpm: this._targetRpm,
      actualRpm: this._actualRpm,
      vbus: this._vbus,
      ibus: this._ibus,
      power: this._power,
      isArmed: this._isArmed,
      axisError: this._axisError
    };
  }
}

module.exports = { ODriveVirtual };
