/**
 * Constantes del firmware, centralizadas para el gemelo digital.
 *
 * REGLA: cada valor lleva su archivo y línea de origen. Si un `config.h` cambia, esto debe cambiar.
 * Ningún valor aquí es inventado: son los del firmware real.
 */

module.exports = {
  /* ===== Codigos/odrive-controller/src/config.h ===== */
  odrive: {
    DEFAULT_TARGET_DO_MG_L: 7.5,
    DEFAULT_KP: 100.0,
    DEFAULT_KI: 1.5,
    DEFAULT_KD: 10.0,
    MIN_MOTOR_RPM: 0.0,
    MAX_MOTOR_RPM: 600.0,
    FAILSAFE_MOTOR_RPM: 0.0,
    FAILSAFE_TIMEOUT_MS: 35000,
    CONTROL_LOOP_INTERVAL_MS: 50,      // 20 Hz determinista en Core 1
    TELEMETRY_PUSH_INTERVAL_MS: 5000,
    COMMAND_POLL_INTERVAL_MS: 1500,    // modo auto
    COMMAND_POLL_INTERVAL_MANUAL_MS: 1000,
    TELEMETRY_SAMPLE_INTERVAL_MS: 200, // 5 Hz
    SD_LOG_INTERVAL_MS: 200,
    WIFI_CONNECT_TIMEOUT_MS: 15000,
    // --- Simulador físico (consumido por odrive_virtual.cpp) ---
    // NOTA DE FIDELIDAD: el env virtual del firmware declara 24 V, pero el banco real es
    // 12 VDC (AGENTS.md regla 12). El gemelo usa el valor del BANCO; el del firmware se conserva
    // abajo para poder comparar.
    VIRTUAL_VBUS_NOMINAL: 12.0,
    VIRTUAL_VBUS_NOMINAL_FIRMWARE: 24.0,
    VIRTUAL_RAMP_RPM_PER_S: 600.0,
    VIRTUAL_IBUS_IDLE: 0.15,
    VIRTUAL_IBUS_MAX_LOAD: 9.5         // coherente con el límite ±10 A del ODrive
  },

  /* ===== Codigos/odrive-controller/src/odrive_virtual.cpp ===== */
  odriveModel: {
    STATE_IDLE: 1,
    STATE_CLOSED_LOOP: 8,
    COAST_RAMP_FACTOR: 1.5,     // coastRamp = rampRate * 1.5 * dt
    DT_CLAMP_S: 0.5,            // dt > 0.5 s se recorta (pausas por reconexión WiFi)
    BUS_INTERNAL_R_OHM: 0.035,  // vbus = nominal - ibus * 0.035
    ACCEL_CURRENT_COEF: 0.0015, // accelCurrent = |dRpm/dt| * 0.0015
    FET_TEMP_BASE_C: 28.0,      // fet_temperature = 28 + ibus * 1.5
    FET_TEMP_PER_AMP: 1.5,
    TORQUE_OMEGA_MIN: 0.1
  },

  /* ===== Codigos/od-logger/src/config.h ===== */
  logger: {
    LOCAL_TZ_OFFSET_SEC: 5 * 3600,  // UTC-5 Perú
    AQUACONTROL_PATH: '/api/telemetry/sensor_bulk',
    DEVICE_KEY: 'ESP32_OD_SENSOR'
  },

  /* ===== Codigos/od-logger/src/n_logger_config.h ===== */
  statusBits: {
    INTERNET: 0,
    FULL_MEMORY: 1,
    CORRUPTED_MEMORY: 2,
    CODE_ERROR: 3,
    SD_CARD: 17,
    TEMPERATURE: 18,
    GPRS: 19,
    OD_SENSOR: 22
  },

  /** Segundos entre 1970-01-01 y 2000-01-01 (convención legacy del RTC). */
  UNIX_OFFSET_2000: 946684800,
  EPOCH_2000_MS: 946684800000
};
