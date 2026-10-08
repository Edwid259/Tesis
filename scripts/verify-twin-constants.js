/**
 * Self-check: deriva de constantes entre el firmware y el gemelo digital.
 * Ejecución: node scripts/verify-twin-constants.js
 *
 * El gemelo (`scripts/virtual-bench/models/`) duplica a propósito constantes del firmware para poder
 * simular sin hardware. Esa duplicación es útil pero peligrosa: si alguien cambia un `config.h` y no
 * el gemelo, el banco virtual empieza a mentir y las validaciones dejan de representar al hardware.
 *
 * Este test lee los `#define` REALES del firmware y los compara con las constantes del gemelo.
 * Si falla, hay que actualizar `scripts/virtual-bench/models/constants.js`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let passed = 0;
const ok = (msg) => { passed++; console.log('  ✓ ' + msg); };

console.log('====================================================');
console.log(' DERIVA DE CONSTANTES: FIRMWARE vs GEMELO DIGITAL    ');
console.log('====================================================\n');

const C = require('./virtual-bench/models/constants');

/** Extrae un `#define NAME <valor>` numérico del firmware (tolera sufijos tipo `f`, `UL`). */
function defineValue(source, name) {
  const re = new RegExp(`#define\\s+${name}\\s+([^\\s/]+)`);
  const m = source.match(re);
  assert.ok(m, `No se encontró #define ${name} en el firmware`);
  return m[1].replace(/[uUlLfF]+$/, '');
}

function expectNumber(firmwareValue, twinValue, label) {
  const fw = Number(firmwareValue);
  assert.ok(Number.isFinite(fw), `${label}: valor de firmware no numérico ('${firmwareValue}')`);
  assert.ok(Math.abs(fw - twinValue) < 1e-9,
    `${label}: firmware=${fw} vs gemelo=${twinValue} — actualiza models/constants.js`);
}

console.log('[Test 1] Límites y lazos del aireador (odrive-controller/src/config.h)...');
const odriveCfg = read('Codigos/odrive-controller/src/config.h');
const pairs = [
  ['MAX_MOTOR_RPM', C.odrive.MAX_MOTOR_RPM],
  ['MIN_MOTOR_RPM', C.odrive.MIN_MOTOR_RPM],
  ['FAILSAFE_MOTOR_RPM', C.odrive.FAILSAFE_MOTOR_RPM],
  ['FAILSAFE_TIMEOUT_MS', C.odrive.FAILSAFE_TIMEOUT_MS],
  ['CONTROL_LOOP_INTERVAL_MS', C.odrive.CONTROL_LOOP_INTERVAL_MS],
  ['TELEMETRY_SAMPLE_INTERVAL_MS', C.odrive.TELEMETRY_SAMPLE_INTERVAL_MS],
  ['TELEMETRY_PUSH_INTERVAL_MS', C.odrive.TELEMETRY_PUSH_INTERVAL_MS],
  ['COMMAND_POLL_INTERVAL_MS', C.odrive.COMMAND_POLL_INTERVAL_MS],
  ['COMMAND_POLL_INTERVAL_MANUAL_MS', C.odrive.COMMAND_POLL_INTERVAL_MANUAL_MS],
  ['DEFAULT_TARGET_DO_MG_L', C.odrive.DEFAULT_TARGET_DO_MG_L],
  ['DEFAULT_KP', C.odrive.DEFAULT_KP],
  ['DEFAULT_KI', C.odrive.DEFAULT_KI],
  ['DEFAULT_KD', C.odrive.DEFAULT_KD],
  ['VIRTUAL_RAMP_RPM_PER_S', C.odrive.VIRTUAL_RAMP_RPM_PER_S],
  ['VIRTUAL_IBUS_IDLE', C.odrive.VIRTUAL_IBUS_IDLE],
  ['VIRTUAL_IBUS_MAX_LOAD', C.odrive.VIRTUAL_IBUS_MAX_LOAD]
];
for (const [name, twin] of pairs) {
  expectNumber(defineValue(odriveCfg, name), twin, name);
}
ok(`${pairs.length} constantes del ODrive verificadas contra el firmware`);

console.log('\n[Test 2] Constantes del modelo físico (odrive_virtual.cpp)...');
const odriveVirt = read('Codigos/odrive-controller/src/odrive_virtual.cpp');
assert.ok(odriveVirt.includes('_rampRate * 1.5f * dt'),
  'COAST_RAMP_FACTOR debe ser 1.5 (coastRamp = rampRate * 1.5 * dt)');
expectNumber('1.5', C.odriveModel.COAST_RAMP_FACTOR, 'COAST_RAMP_FACTOR');
assert.ok(odriveVirt.includes('dt > 0.5f'), 'DT_CLAMP_S debe ser 0.5');
assert.ok(odriveVirt.includes('_ibus * 0.035f'), 'BUS_INTERNAL_R_OHM debe ser 0.035');
assert.ok(odriveVirt.includes('0.0015f'), 'ACCEL_CURRENT_COEF debe ser 0.0015');
assert.ok(odriveVirt.includes('28.0f') && odriveVirt.includes('_ibus * 1.5f'),
  'FET_TEMP debe ser 28 + ibus*1.5');
assert.ok(odriveVirt.includes('omegaRadS > 0.1f'), 'TORQUE_OMEGA_MIN debe ser 0.1');
assert.ok(odriveVirt.includes('_nominalRpm') === false && odriveVirt.includes('normSpeed * normSpeed'),
  'La carga debe ser cuadrática con la velocidad');
ok('6 constantes del modelo físico verificadas');

console.log('\n[Test 3] Sensor OPTOD (od-logger/src/n_logger_config.h)...');
const loggerCfg = read('Codigos/od-logger/src/n_logger_config.h');
const loggerPairs = [
  ['OD_SLAVE_ID', 'SLAVE_ID'],
  ['OD_MODBUS_READ_COUNT', 'READ_COUNT'],
  ['OD_DEFAULT_SAMPLING_DELAY_MS', 'DEFAULT_SAMPLING_DELAY_MS'],
  ['OD_WARMUP_MS', 'WARMUP_MS'],
  ['OD_NUM_READINGS', 'NUM_READINGS']
];
const model = require('./virtual-bench/models/odLogger');
for (const [name, key] of loggerPairs) {
  expectNumber(defineValue(loggerCfg, name), model.OD[key], name);
}
expectNumber(defineValue(loggerCfg, 'OD_BAUD'), model.OD.BAUD, 'OD_BAUD');

// El bit de confianza debe coincidir con el firmware
const nLoggerConfig = read('Codigos/od-logger/src/n_logger_config.h');
const odBit = Number(defineValue(nLoggerConfig, 'STATUS_OD_SENSOR_BIT'));
assert.strictEqual(odBit, C.statusBits.OD_SENSOR,
  `STATUS_OD_SENSOR_BIT: firmware=${odBit} vs gemelo=${C.statusBits.OD_SENSOR}`);
ok('Sensor: baud, esclavo, registros, warm-up y bit de estado verificados');

console.log('\n[Test 4] El enlace ESP-NOW conserva la frontera de confianza...');
const { isSampleValid } = require('./virtual-bench/models/espnow');
const validPacket = { status_flags: 0 };
const failedPacket = { status_flags: 1 << C.statusBits.OD_SENSOR };
assert.strictEqual(isSampleValid(validPacket), true, 'Una muestra sin bits de error debe ser válida');
assert.strictEqual(isSampleValid(failedPacket), false, 'El bit 22 debe invalidar la muestra');
// El firmware marca el bit y transmite ceros: es exactamente el caso peligroso
const { OdLogger } = model;
const s = new OdLogger({});
s.setFault('noResponse');
const m = s.takeMeasurement(Date.now());
assert.strictEqual(m.readings[2], 0, 'Con el sensor averiado el firmware transmite DO=0');
assert.ok((m.status & (1 << C.statusBits.OD_SENSOR)) !== 0, 'Y además marca el bit 22');
assert.strictEqual(isSampleValid({ status_flags: m.status }), false, 'El receptor debe rechazarla');
ok('Ceros + bit 22 se detectan y se rechazan (no entran al lazo)');

console.log('\n[Test 5] El receptor del gemelo respeta la frontera...');
const fleetSrc = read('Tesis_webpage/scripts/virtual-bench/fleet.js');
assert.ok(fleetSrc.includes('onEspNowRejected'), 'El nodo debe exponer el camino de rechazo');
assert.ok(/onRejected:\s*\(\)\s*=>\s*odrive\.onEspNowRejected\(\)/.test(fleetSrc),
  'El enlace debe cablear el rechazo al nodo');
assert.ok(!/rejectedSamples\+\+[\s\S]{0,200}updateProcessVariable/.test(fleetSrc),
  'REGRESIÓN: una muestra rechazada no debe actualizar la variable de proceso');
ok('El gemelo no inyecta el cero fantasma en el lazo');

console.log('\n====================================================');
console.log(` SIN DERIVA: EL GEMELO REPRESENTA AL FIRMWARE (${passed}/5) `);
console.log('====================================================');
assert.ok(passed === 5, `Se esperaban 5 bloques, se ejecutaron ${passed}`);
