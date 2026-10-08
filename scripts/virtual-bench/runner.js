/**
 * Banco de pruebas virtual: ejecuta escenarios contra la API real con la flota simulada y verifica
 * el contrato de orquestación de punta a punta.
 *
 * Uso:
 *   node scripts/virtual-bench/runner.js                       # todos los escenarios, contra producción
 *   node scripts/virtual-bench/runner.js --scenario planta2
 *   node scripts/virtual-bench/runner.js --dry-run             # no escribe nada
 *   node scripts/virtual-bench/runner.js --target local        # contra `npm run dev`
 *
 * SEGURIDAD: se niega a correr si el orquestador no está en IDLE (salvo `--force`), snapshotea los
 * `id` máximos de cada tabla y borra EXACTAMENTE lo que creó. Siempre restaura el `system_state`
 * previo y elimina los experimentos de prueba, incluso si un escenario falla.
 */
const { parseArgs, resolveSupabaseCreds, CADENCE } = require('./config');
const { ApiClient, Store } = require('./transport');
const { buildFleet } = require('./fleet');
const { ProcessModel, doSaturationMgL, UNIDENTIFIED } = require('./models/process');

/** Roles reales del banco. La planta se expone junto a la flota, así que nunca se itera `fleet`. */
const NODE_ROLES = ['sensor', 'odrive', 'mixer', 'pump'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Espera activa hasta que `predicate()` sea verdadero o venza el plazo. */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  throw new Error(`Timeout esperando: ${label} (${timeoutMs} ms)`);
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Espera a que el nodo reciba una acción concreta. */
async function expectAction(node, action, timeoutMs = 20000) {
  try {
    await waitFor(() => node.gotAction(action), timeoutMs, `${node.role} reciba '${action}'`);
  } catch (e) {
    throw new Error(`${e.message}. Acciones vistas por ${node.role}: [${node.actionsSeen().join(', ') || 'ninguna'}]`);
  }
}

function expectNoAction(node, action) {
  assertTrue(!node.gotAction(action),
    `${node.role} NO debería recibir '${action}' (recibió: [${node.actionsSeen().join(', ')}])`);
}

/** Verifica que un nodo no reciba acciones de otro rol (entrega cruzada). */
function expectNoForeignActions(node) {
  const foreign = node.foreignActions();
  assertTrue(foreign.length === 0,
    `Entrega cruzada: ${node.role} recibió acciones ajenas [${foreign.join(', ')}]`);
}

/** Extrae el payload de la primera orden recibida con esa acción. */
function payloadOf(node, action) {
  const entry = node.received.find(r => r.action === action);
  return entry ? entry.payload : null;
}

/* =============================== Escenarios =============================== */

const SCENARIOS = {
  /** Planta 1: mixer ON (disuelve el Na2SO3), ODrive deliberadamente apagado. */
  planta1: {
    description: 'Planta 1 (desoxigenación): mixer encendido y aireador apagado',
    async run({ createExperiment, fleet }) {
      const exp = await createExperiment({
        case_type: 'planta_1_deox', plant_target: 'planta_1', controller_type: 'none', parameters: {}
      });
      // `armed` es la declaración del propio servidor sobre la receta: se contrasta con lo que
      // realmente recibe cada nodo, sin reimplementar la tabla de decisión aquí.
      assertTrue(exp.armed.includes('mixer'), `El servidor debe declarar el mixer armado (armed: [${exp.armed.join(', ')}])`);
      assertTrue(!exp.armed.includes('odrive'), `Planta 1 no debe armar el aireador (armed: [${exp.armed.join(', ')}])`);

      // La intención viaja en el `set_state` difundido (vía única para los 4 nodos).
      await expectAction(fleet.mixer, 'set_state');
      await waitFor(() => fleet.mixer.lastPayloadOf('set_state')?.mixer !== undefined, 15000,
        'que el mixer reciba su intención');
      const mix = fleet.mixer.lastPayloadOf('set_state');
      assertTrue(mix.mixer === 'on', `El mixer debe recibir mixer='on' en Planta 1 (recibió '${mix.mixer}')`);
      assertTrue(fleet.mixer.targetRpm > 0, 'El mixer debe estar girando');

      const motor = fleet.odrive.lastPayloadOf('set_state');
      assertTrue(motor.motor_mode === 'off',
        `El aireador debe quedar en motor_mode 'off' en Planta 1 (recibió '${motor.motor_mode}')`);
      assertTrue(fleet.odrive.loopState().targetRpm === 0, 'El aireador no debe demandar RPM');
      return ["armed=[mixer]", "mixer='on' girando", "aireador en motor_mode 'off'"];
    }
  },

  /** Planta 2: escalón de aireación. El mixer debe DETENERSE (su agitación sesga KLa). */
  planta2: {
    description: 'Planta 2 (escalón KLa): mixer detenido y aireador al escalón',
    async run({ createExperiment, fleet }) {
      const exp = await createExperiment({
        case_type: 'planta_2_step', plant_target: 'planta_2', controller_type: 'none',
        parameters: { step_throttle_pct: 40 }
      });
      assertTrue(exp.armed.includes('odrive'), `El servidor debe declarar el aireador armado (armed: [${exp.armed.join(', ')}])`);
      assertTrue(exp.armed.includes('mixer_off'), `El servidor debe declarar el mixer detenido (armed: [${exp.armed.join(', ')}])`);

      await waitFor(() => fleet.odrive.lastPayloadOf('set_state')?.motor_mode !== undefined, 15000,
        'que el aireador reciba su intención');
      await waitFor(() => fleet.mixer.lastPayloadOf('set_state')?.mixer !== undefined, 15000,
        'que el mixer reciba su intención');

      const motor = fleet.odrive.lastPayloadOf('set_state');
      assertTrue(motor.motor_mode === 'manual', `El aireador debe armarse en manual (recibió '${motor.motor_mode}')`);
      assertTrue(Number(motor.motor_throttle_pct) === 40,
        `El escalón debe ser 40% (recibió ${motor.motor_throttle_pct})`);

      const mix = fleet.mixer.lastPayloadOf('set_state');
      assertTrue(mix.mixer === 'off', `El mixer debe recibir mixer='off' (recibió '${mix.mixer}')`);
      await waitFor(() => fleet.mixer.targetRpm === 0, 10000, 'que el mixer se detenga');
      assertTrue(fleet.mixer.targetRpm === 0, 'El mixer debe estar detenido');

      // El aireador debe GIRAR de verdad: es lo que nunca ocurría antes.
      await waitFor(() => fleet.odrive.loopState().actualRpm > 1, 15000,
        `El aireador debe girar tras armarse al 40% (RPM actual: ${fleet.odrive.loopState().actualRpm})`);
      const rpm = fleet.odrive.loopState().actualRpm;
      return [`escalón 40%`, `aireador girando a ${rpm.toFixed(1)} RPM`, 'mixer detenido'];
    }
  },

  /** Caso B: lazo cerrado. El aireador debe armarse en PID con el setpoint. */
  pidArming: {
    description: 'Caso B (armado PID): el aireador queda en PID con el setpoint y el signo es correcto',
    async run({ createExperiment, fleet }) {
      const exp = await createExperiment({
        case_type: 'closed_loop', plant_target: 'planta_2', controller_type: 'pid',
        setpoint_do: 5.0, parameters: {}
      });
      assertTrue(exp.armed.includes('odrive'), 'El servidor debe declarar el aireador armado');

      await waitFor(() => fleet.odrive.lastPayloadOf('set_state')?.motor_mode === 'pid', 15000,
        `que el aireador reciba motor_mode 'pid' (recibió '${fleet.odrive.lastPayloadOf('set_state')?.motor_mode}')`);
      const motor = fleet.odrive.lastPayloadOf('set_state');
      assertTrue(Number(motor.motor_target_do) === 5.0,
        `El setpoint debe viajar (recibió ${motor.motor_target_do})`);
      assertTrue(fleet.odrive.engine.getConfig().target_do_mg_l === 5.0,
        'El motor de control debe quedar con el setpoint de 5.0 mg/L');

      // Con el OD real por debajo del setpoint, el PID debe demandar RPM: valida el SIGNO de la ley
      // de control. NO valida estabilidad, sobreimpulso ni ganancias: aquí no hay lazo cerrado real
      // (la planta no realimenta al controlador), y las ganancias siguen siendo DEFAULT_*.
      fleet.sensor.setTrueDo(2.0);
      await waitFor(() => fleet.odrive.loopState().targetRpm > 0, 45000,
        'el PID debe demandar RPM con OD por debajo del setpoint');
      const st = fleet.odrive.loopState();
      return ['PID con setpoint 5.0', `demanda ${st.targetRpm.toFixed(1)} RPM (signo correcto)`, 'OD forzado a 2.0 mg/L'];
    }
  },

  /** El sensor debe enterarse de que hay experimento: si no, no muestrea y no hay curva. */
  sensorSampling: {
    description: 'El sensor recibe la orden de muestrear al iniciar un experimento',
    async run({ createExperiment, fleet }) {
      // Se espera el EFECTO (el sensor sabe que hay experimento y muestrea), no una acción concreta:
      // hay dos caminos que lo avisan (`start_experiment` y el `set_state` difundido), y cuál llega
      // primero depende del orden de encolado. Lo que importa es que el sensor acabe muestreando.
      await createExperiment({
        case_type: 'planta_2_step', plant_target: 'planta_2', controller_type: 'none',
        parameters: { step_throttle_pct: 30 }
      });
      await waitFor(() => fleet.sensor.systemState === 'ACTIVE_EXPERIMENT', 25000,
        'que el sensor pase a estado ACTIVE_EXPERIMENT');
      await waitFor(() => fleet.sensor.telemetryCount > 0, 30000,
        'que el sensor publique telemetría al estar muestreando');

      assertTrue(fleet.sensor.systemState === 'ACTIVE_EXPERIMENT', 'El sensor debe estar muestreando');
      return [
        'el sensor sabe que hay experimento',
        `ha publicado ${fleet.sensor.telemetryCount} lote(s)`,
        'la curva del ensayo ya puede existir'
      ];
    }
  },

  /**
   * INTEGRIDAD DEL NODO AIREADOR: se le manda una velocidad y debe responder con la telemetría
   * esperada, en la misma forma que el hardware real (campos, unidades y relación consigna↔real).
   */
  nodeMotor: {
    description: 'Integridad del aireador: a una consigna responde con la telemetría esperada',
    async run({ fleet, devices, api, sleep }) {
      for (const pct of [25, 50]) {
        const res = await api.post('/api/commands', {
          device_id: devices.odrive.id,
          command_type: 'set_speed',
          speed_percent: pct,
          payload: { action: 'force_on', manual_throttle_pct: pct },
          requested_by: `Banco virtual (integridad ${pct}%)`
        });
        assertTrue(res.ok, `No se pudo encolar ${pct}% (HTTP ${res.status})`);
        const expectedRpm = (pct / 100) * 600;

        // El firmware arma por rampa (600 RPM/s), así que se espera a que alcance la consigna.
        await waitFor(() => Math.abs(fleet.odrive.loopState().actualRpm - expectedRpm) < expectedRpm * 0.05,
          15000, `que el motor alcance ~${expectedRpm} RPM al ${pct}% (actual ${fleet.odrive.loopState().actualRpm.toFixed(1)})`);
        await sleep(1500);

        // La forma de la telemetría debe ser la del hardware real.
        const last = fleet.odrive.buffer[fleet.odrive.buffer.length - 1] || fleet.odrive.lastSample;
        assertTrue(last, 'El aireador debe estar generando muestras de telemetría');
        for (const field of ['is_on', 'speed_percent', 'pwm_us', 'actual_rpm', 'target_rpm',
          'voltage_v', 'current_a', 'power_w', 'status_code', 'rtc_timestamp_ms']) {
          assertTrue(last[field] !== undefined, `La telemetría debe incluir '${field}'`);
        }
        assertTrue(last.is_on === true, 'Con consigna > 0 debe reportar is_on=true');
        assertTrue(Math.abs(last.speed_percent - pct) < 3,
          `speed_percent debe reflejar el ${pct}% (reportó ${last.speed_percent})`);
        assertTrue(Math.abs(last.actual_rpm - expectedRpm) < expectedRpm * 0.08,
          `actual_rpm debe ser ~${expectedRpm} (reportó ${last.actual_rpm})`);
        // Con el bus en 12 V y carga, la corriente no puede ser cero.
        assertTrue(last.current_a > 0, `Girando debe consumir corriente (reportó ${last.current_a} A)`);
        assertTrue(last.voltage_v > 8 && last.voltage_v <= 12.1,
          `La tensión debe caer dentro del rango del bus de 12 V (reportó ${last.voltage_v} V)`);
      }

      // Y a 0 debe quedar realmente parado.
      await api.post('/api/commands', {
        device_id: devices.odrive.id, command_type: 'stop', speed_percent: 0,
        payload: { action: 'force_off' }, requested_by: 'Banco virtual'
      });
      await waitFor(() => fleet.odrive.loopState().actualRpm < 1, 30000, 'que el motor se detenga');
      return ['25% -> ~150 RPM con telemetría completa', '50% -> ~300 RPM', 'a 0 queda parado'];
    }
  },

  /** INTEGRIDAD DEL MIXER: consigna de mezcla y su telemetría. */
  nodeMixer: {
    description: 'Integridad del mixer: gira al comando y reporta su telemetría',
    async run({ fleet, devices, api, waitFor }) {
      const res = await api.post('/api/commands', {
        device_id: devices.mixer.id, command_type: 'set_speed', speed_percent: 60,
        payload: { action: 'start_mixer' }, requested_by: 'Banco virtual (integridad mixer)'
      });
      assertTrue(res.ok, `No se pudo encolar el mixer (HTTP ${res.status})`);
      await waitFor(() => fleet.mixer.actualRpm > 1, 20000, 'que el mixer gire');

      const st = fleet.mixer;
      assertTrue(st.targetRpm > 0 && st.targetRpm <= 1000,
        `La consigna debe estar dentro del tope del ESC (1000 RPM), reportó ${st.targetRpm}`);
      assertTrue(st.actualRpm > 1, `El mixer debe estar girando (reportó ${st.actualRpm.toFixed(0)} RPM)`);
      // El duty es la salida del PI y oscila alrededor del punto de operación; lo que importa es que
      // se mantenga dentro de la saturación del PWM.
      assertTrue(st.duty >= 0 && st.duty <= 100,
        `El duty debe estar en 0-100 % (reportó ${st.duty})`);
      assertTrue(st.mixerEvents.length > 0, 'Debe haber registrado el evento start_mixer');

      const off = await api.post('/api/commands', {
        device_id: devices.mixer.id, command_type: 'stop', speed_percent: 0,
        payload: { action: 'stop_mixer' }, requested_by: 'Banco virtual'
      });
      assertTrue(off.ok, `No se pudo detener el mixer (HTTP ${off.status})`);
      await waitFor(() => st.targetRpm === 0, 10000, 'que el mixer se detenga');
      return [`gira a ${st.actualRpm.toFixed(0)} RPM (tope ESC 1000)`, 'evento start_mixer registrado', 'se detiene'];
    }
  },
  /** INTEGRIDAD DEL SENSOR: el ítem que publica debe tener la forma exacta del hardware real. */
  nodeSensor: {
    description: 'Integridad del sensor: el payload bulk tiene la forma del hardware real',
    async run({ fleet, createExperiment, waitFor }) {
      await createExperiment({
        case_type: 'planta_2_step', plant_target: 'planta_2', controller_type: 'none',
        parameters: { step_throttle_pct: 20 }
      });
      await waitFor(() => fleet.sensor.lastMeasurement?.ok === true, 30000,
        'que el sensor obtenga una medición válida');

      const item = fleet.sensor.sensor.toBulkItem(fleet.sensor.lastMeasurement);
      for (const field of ['datetime', 'seconds_since_2000', 'rtc_timestamp_ms', 'water_temp_centi',
        'do_sat_deci_pct', 'do_milli_mg_l', 'param3_centi', 'param4_centi', 'status']) {
        assertTrue(item[field] !== undefined, `El ítem bulk debe incluir '${field}'`);
      }
      // Unidades nativas del firmware: entero en milli-mg/L, no un float en mg/L.
      assertTrue(Number.isInteger(item.do_milli_mg_l),
        `do_milli_mg_l debe ser entero en milli-mg/L (es ${item.do_milli_mg_l})`);
      assertTrue(item.do_milli_mg_l === Math.round(fleet.process.doMgL * 1000) ||
        Math.abs(item.do_milli_mg_l / 1000 - fleet.process.doMgL) < 0.01,
        'El OD reportado debe corresponder al de la planta');
      // Coherencia %Sat ↔ mg/L con la solubilidad real a esa temperatura.
      const sat = doSaturationMgL(item.water_temp_centi / 100);
      const expectedPct = (item.do_milli_mg_l / 1000 / sat) * 100;
      assertTrue(Math.abs(item.do_sat_deci_pct / 10 - expectedPct) < 3,
        `La saturación debe ser coherente con la solubilidad real (reportó ${item.do_sat_deci_pct / 10}%, esperado ~${expectedPct.toFixed(1)}%)`);
      assertTrue(fleet.sensor.rejectedSamples === undefined, 'El camino de rechazo es del receptor, no del emisor');
      return [`${item.do_milli_mg_l} milli-mg/L (entero)`, `${item.water_temp_centi / 100} °C`, 'saturación coherente con la solubilidad real'];
    }
  },

  /**
   * FLUJO DEL SISTEMA — AIREACIÓN: al girar el motor, el OD del sensor debe SUBIR hacia saturación.
   * No hay lazo cerrado: se observa que el sistema completo trabaja coordinado.
   */
  systemFlowAeration: {
    description: 'Flujo: el aireador sube el OD hasta saturar',
    async run({ fleet, devices, api, waitFor }) {
      // Se parte de agua desoxigenada.
      fleet.process.doMgL = 2.0;
      const before = fleet.process.doMgL;

      await api.post('/api/commands', {
        device_id: devices.odrive.id, command_type: 'set_speed', speed_percent: 100,
        payload: { action: 'force_on', manual_throttle_pct: 100 }, requested_by: 'Banco virtual (flujo aireación)'
      });
      await waitFor(() => fleet.odrive.loopState().actualRpm > 300, 20000, 'que el aireador acelere');

      // El OD debe subir de forma monótona.
      await waitFor(() => fleet.process.doMgL > before + 0.5, 60000,
        `que el OD suba por la aireación (de ${before.toFixed(2)} a ${fleet.process.doMgL.toFixed(2)})`);
      const midDo = fleet.process.doMgL;

      // Y el sensor debe estar reportando ese ascenso.
      await waitFor(() => fleet.sensor.lastMeasurement?.ok && fleet.sensor.lastMeasurement.readings[2] > 0, 30000,
        'que el sensor reporte el OD creciente');

      const snap = fleet.process.snapshot();
      assertTrue(snap.kla > 0, 'La aireación debe aportar KLa > 0');
      assertTrue(midDo > before, `El OD debe haber subido (${before.toFixed(2)} -> ${midDo.toFixed(2)} mg/L)`);

      // Se detiene el aireador y el OD deja de subir.
      await api.post('/api/commands', {
        device_id: devices.odrive.id, command_type: 'stop', speed_percent: 0,
        payload: { action: 'force_off' }, requested_by: 'Banco virtual'
      });
      await waitFor(() => fleet.odrive.loopState().actualRpm < 1, 30000, 'que el aireador se detenga');
      assertTrue(fleet.process.snapshot().kla < 1e-6, 'Sin giro no debe haber transferencia por aireación');

      return [
        `OD ${before.toFixed(2)} -> ${midDo.toFixed(2)} mg/L girando al 100%`,
        `KLa aplicado ${snap.kla.toFixed(4)}/s`,
        'el sensor reporta el ascenso',
        'parado, KLa = 0'
      ];
    }
  },

  /**
   * FLUJO DEL SISTEMA — DESOXIGENACIÓN: al inyectar sulfito el OD debe CAER.
   * Se valida además que la agitación del mixer acelera la caída (regla 11).
   */
  systemFlowDeoxygenation: {
    description: 'Flujo: el sulfito baja el OD y la agitación lo acelera',
    async run({ fleet, devices, api, waitFor, sleep }) {
      fleet.process.doMgL = 8.0;
      fleet.process.sulfiteDemandMgL = 0;
      const before = fleet.process.doMgL;

      // 1. Inyección SIN agitación
      const dose = 20; // mL de disolución madre 100 g/L
      const demand = fleet.process.injectSulfite(dose, 100);
      assertTrue(demand > 0, 'La dosis debe generar demanda de oxígeno');

      await waitFor(() => fleet.process.doMgL < before - 0.3, 60000,
        `que el OD caiga tras inyectar sulfito (de ${before.toFixed(2)} a ${fleet.process.doMgL.toFixed(2)})`);
      const afterNoMix = fleet.process.doMgL;

      // 2. Con agitación la reacción es más rápida: se compara la caída por segundo
      fleet.process.doMgL = 8.0;
      fleet.process.sulfiteDemandMgL = 0;
      fleet.process.setMixer(true);
      fleet.process.injectSulfite(dose, 100);
      const t0 = Date.now();
      await waitFor(() => fleet.process.doMgL < 8.0 - 1.0, 60000, 'que caiga con agitación');
      const msWithMix = Date.now() - t0;

      const st = fleet.process.snapshot();
      assertTrue(st.doMgL < 8.0, 'Con agitación el OD debe caer más rápido');
      assertTrue(msWithMix < 60000, `La agitación debe acelerar la caída (tardó ${msWithMix} ms)`);

      fleet.process.setMixer(false);
      await api.post('/api/system/state', { state: 'IDLE', requested_by: 'Banco virtual' });
      return [
        `${dose} mL de 100 g/L => demanda ${demand.toFixed(2)} mg/L de O2`,
        `sin mezcla el OD cayó a ${afterNoMix.toFixed(2)} mg/L`,
        `con mezcla cae más rápido (${(msWithMix / 1000).toFixed(1)} s para -1.0 mg/L)`
      ];
    }
  },

  /**
   * SECUENCIA COORDINADA: Planta 1 (desoxigenar) seguida de Planta 2 (airear), observando que el OD
   * baja y luego sube, y que cada actuador se comporta como corresponde a su fase del protocolo.
   */
  coordinatedSequence: {
    description: 'Secuencia completa: desoxigenar y luego airear, con los 4 nodos coordinados',
    async run({ fleet, createExperiment, waitFor, api, devices }) {
      // ---- Fase 1: Planta 1 (mixer ON, aireador OFF) ----
      fleet.process.doMgL = 8.0;
      fleet.process.sulfiteDemandMgL = 0;
      const exp1 = await createExperiment({
        case_type: 'planta_1_deox', plant_target: 'planta_1', controller_type: 'none', parameters: {}
      });
      assertTrue(exp1.armed.includes('mixer'), 'Planta 1 debe armar el mixer');
      assertTrue(!exp1.armed.includes('odrive'), 'Planta 1 no debe armar el aireador');

      await waitFor(() => fleet.mixer.targetRpm > 0, 20000, 'que el mixer gire en Planta 1');
      assertTrue(fleet.odrive.loopState().targetRpm === 0, 'El aireador debe estar parado en Planta 1');
      assertTrue(fleet.process.mixerOn === true, 'La planta debe saber que hay agitación');

      // La inyección desoxigena
      fleet.process.injectSulfite(20, 100);
      await waitFor(() => fleet.process.doMgL < 7.0, 60000, 'que desoxigene en Planta 1');

      // El protocolo exige esperar a que no quede sulfito residual antes de pasar a aireación:
      // si queda reactivo, seguiría consumiendo oxígeno más rápido de lo que el aireador aporta y la
      // fase de reoxigenación no arrancaría (la curva seguiría bajando).
      await waitFor(() => fleet.process.sulfiteDemandMgL < 0.05, 90000,
        `que se agote el sulfito residual (quedan ${fleet.process.sulfiteDemandMgL.toFixed(3)} mg/L)`);
      const deoxDo = fleet.process.doMgL;
      assertTrue(fleet.process.sulfiteDemandMgL < 0.05,
        'Sin residual: la derivada se anula, condición para pasar a Planta 2');

      // ---- Fase 2: Planta 2 (mixer OFF, aireador al escalón) ----
      const exp2 = await createExperiment({
        case_type: 'planta_2_step', plant_target: 'planta_2', controller_type: 'none',
        parameters: { step_throttle_pct: 80 }
      });
      assertTrue(exp2.armed.includes('odrive'), 'Planta 2 debe armar el aireador');
      assertTrue(exp2.armed.includes('mixer_off'), 'Planta 2 debe detener el mixer');

      await waitFor(() => fleet.mixer.targetRpm === 0, 20000, 'que el mixer se detenga en Planta 2');
      await waitFor(() => fleet.odrive.loopState().actualRpm > 100, 20000, 'que el aireador gire en Planta 2');

      // La aireación recupera el oxígeno
      await waitFor(() => fleet.process.doMgL > deoxDo + 0.5, 60000,
        `que el OD se recupere en Planta 2 (de ${deoxDo.toFixed(2)} a ${fleet.process.doMgL.toFixed(2)})`);
      const reoxDo = fleet.process.doMgL;

      // ---- Verificación de coordinación ----
      assertTrue(reoxDo > deoxDo,
        `El ciclo debe cerrar: OD bajó a ${deoxDo.toFixed(2)} y subió a ${reoxDo.toFixed(2)} mg/L`);
      assertTrue(fleet.sensor.telemetryCount >= 2, 'El sensor debe haber publicado durante ambas fases');

      const snap = fleet.process.snapshot();
      return [
        `Planta 1: mixer ON, aireador 0 RPM, OD 8.00 -> ${deoxDo.toFixed(2)} mg/L (sin residual)`,
        `Planta 2: mixer OFF, aireador ${fleet.odrive.loopState().actualRpm.toFixed(0)} RPM, OD -> ${reoxDo.toFixed(2)} mg/L`,
        `el ciclo baja y sube (${snap.simSeconds.toFixed(0)} s simulados)`,
        'los 4 nodos siguen su fase del protocolo'
      ];
    }
  },

  /** El E-Stop NO debe liberarse solo al recibir un nuevo estado/receta. */
  estopPersistence: {
    description: 'El E-Stop no se libera implícitamente al armar una receta',
    async run({ fleet, devices, api, createExperiment, waitFor }) {
      await api.post('/api/commands', {
        device_id: devices.odrive.id, command_type: 'emergency_stop', speed_percent: 0,
        payload: { action: 'emergency_stop' }, requested_by: 'Banco virtual'
      });
      await waitFor(() => fleet.odrive.loopState().eStop === true, 15000, 'que latchee el E-Stop');

      await createExperiment({
        case_type: 'planta_2_step', plant_target: 'planta_2', controller_type: 'none',
        parameters: { step_throttle_pct: 60 }
      });
      await waitFor(() => fleet.odrive.lastPayloadOf('set_state')?.motor_mode === 'manual', 15000,
        'que llegue la receta');

      assertTrue(fleet.odrive.loopState().eStop === true,
        'Armar una receta NO debe liberar un E-Stop (el armado usa configure(), no setManualThrottle())');
      assertTrue(fleet.odrive.loopState().targetRpm === 0, 'Con el latch activo el motor debe seguir a 0 RPM');

      await api.post('/api/commands', {
        device_id: devices.odrive.id, command_type: 'set_speed', speed_percent: 0,
        payload: { action: 'clear_estop' }, requested_by: 'Banco virtual'
      });
      await waitFor(() => fleet.odrive.loopState().eStop === false, 15000, 'que clear_estop lo libere');
      return ['la receta no libera el E-Stop', 'el motor sigue a 0 RPM', 'clear_estop sí lo libera'];
    }
  },

  /** MANUAL_OVERRIDE debe abortar cualquier receta y dejar todo en OFF. */
  manualOverride: {
    description: 'MANUAL_OVERRIDE detiene todos los actuadores',
    async run({ api, fleet }) {
      const res = await api.post('/api/system/state', { state: 'MANUAL_OVERRIDE', requested_by: 'Banco virtual' });
      assertTrue(res.ok, `La transición a MANUAL_OVERRIDE falló (HTTP ${res.status})`);

      await expectAction(fleet.mixer, 'set_state');
      await expectAction(fleet.odrive, 'set_state');
      await waitFor(() => fleet.mixer.lastPayloadOf('set_state')?.mixer !== undefined &&
        fleet.odrive.lastPayloadOf('set_state')?.motor_mode !== undefined, 15000,
        'que ambos actuadores reciban su intención');
      const mix = fleet.mixer.lastPayloadOf('set_state');
      const mot = fleet.odrive.lastPayloadOf('set_state');
      assertTrue(mix.state === 'MANUAL_OVERRIDE' && mix.mixer === 'off',
        `El mixer debe recibir state=MANUAL_OVERRIDE y mixer='off' (recibió ${mix.state}/${mix.mixer})`);
      assertTrue(mot.state === 'MANUAL_OVERRIDE' && mot.motor_mode === 'off',
        `El motor debe recibir state=MANUAL_OVERRIDE y motor_mode='off' (recibió ${mot.state}/${mot.motor_mode})`);
      assertTrue(fleet.odrive.loopState().targetRpm === 0, 'El aireador debe quedar a 0 RPM');
      assertTrue(fleet.mixer.targetRpm === 0, 'El mixer debe quedar detenido');
      return ['mixer=off', 'motor_mode=off', 'receta abortada en los 4 nodos'];
    }
  },

  /** E-Stop y su liberación explícita: antes no había forma de salir del latch. */
  estop: {
    description: 'E-Stop y liberación explícita con clear_estop',
    async run({ api, fleet, devices }) {
      const stop = await api.post('/api/commands', {
        device_id: devices.odrive.id,
        command_type: 'emergency_stop',
        speed_percent: 0,
        payload: { action: 'emergency_stop' },
        requested_by: 'Banco virtual'
      });
      assertTrue(stop.ok, `No se pudo encolar el E-Stop (HTTP ${stop.status})`);
      await expectAction(fleet.odrive, 'emergency_stop');
      await waitFor(() => fleet.odrive.loopState().eStop === true, 5000, 'que el latch quede activo');
      assertTrue(fleet.odrive.loopState().targetRpm === 0, 'El E-Stop debe forzar 0 RPM');

      const resume = await api.post('/api/commands', {
        device_id: devices.odrive.id,
        command_type: 'set_speed',
        speed_percent: 0,
        payload: { action: 'clear_estop' },
        requested_by: 'Banco virtual'
      });
      assertTrue(resume.ok, `No se pudo encolar clear_estop (HTTP ${resume.status})`);
      await expectAction(fleet.odrive, 'clear_estop');
      await waitFor(() => fleet.odrive.loopState().eStop === false, 5000, 'que el latch se libere');
      assertTrue(fleet.odrive.engine.isEmergencyStopActive() === false, 'clear_estop debe liberar el latch');

      // El E-Stop NO debe liberarse solo al recibir un nuevo estado/receta.
      return ['E-Stop latcheado a 0 RPM', 'clear_estop libera el latch', 'el armado no lo libera implícitamente'];
    }
  },

  /**
   * CARACTERIZACIÓN DE UN HUECO DE SEGURIDAD REAL.
   *
   * El watchdog de 35 s se evalúa DESPUÉS del branch de modo MANUAL, tanto en el firmware como en
   * el gemelo. Consecuencia: en MANUAL no hay failsafe alguno — si el enlace con el sensor muere,
   * el motor conserva el último throttle indefinidamente. En PID sí actúa el watchdog.
   *
   * Este escenario fija ese comportamiento para que cualquier cambio en el firmware sea visible.
   */
  manualFailsafeGap: {
    description: 'Caracterización: en MANUAL el watchdog de 35 s NO actúa (sólo protege al PID)',
    async run({ fleet, devices, api }) {
      // Modo MANUAL con throttle distinto de cero
      const res = await api.post('/api/commands', {
        device_id: devices.odrive.id,
        command_type: 'set_speed',
        speed_percent: 25,
        payload: { action: 'force_on', manual_throttle_pct: 25 },
        requested_by: 'Banco virtual (caracterización)'
      });
      assertTrue(res.ok, `No se pudo armar en manual (HTTP ${res.status})`);
      await expectAction(fleet.odrive, 'force_on');
      await waitFor(() => fleet.odrive.loopState().targetRpm > 0, 10000, 'que demande RPM en manual');

      // Se corta el enlace del sensor
      fleet.sensor.setFault('noResponse');
      await waitFor(() => fleet.odrive.rejectedSamples > 0, 30000, 'que lleguen muestras inválidas');

      // No se esperan 35 s completos: se comprueba que el watchdog NO está armado en manual.
      const st = fleet.odrive.loopState();
      assertTrue(st.mode === 2, `El motor debe estar en modo MANUAL (mode=${st.mode})`);
      assertTrue(st.failsafe === false,
        'En MANUAL el watchdog no debe activarse (comportamiento real del firmware)');
      assertTrue(st.targetRpm > 0,
        `En MANUAL el motor conserva su consigna aunque el sensor muera (target=${st.targetRpm} RPM)`);

      fleet.sensor.setFault('none');
      return [
        'modo MANUAL: el watchdog NO protege',
        `conserva ${st.targetRpm.toFixed(0)} RPM sin sensor`,
        'un PID con sensor muerto SÍ frena (ver escenario espnowTrust)'
      ];
    }
  },

  /**
   * FRONTERA DE CONFIANZA de `status_flags` en lazo cerrado (PID).
   *
   * Con el sensor averiado el logger transmite DO=0.000 con el bit 22 activo. El receptor debe
   * DESCARTAR esa muestra: si la aceptara, el PID vería un error enorme y llevaría el motor a fondo.
   * Al descartarla, la variable de proceso no se refresca y el watchdog de 35 s frena el motor.
   */
  espnowTrust: {
    description: 'PID + fallo de sensor: el cero fantasma no entra al lazo y actúa el watchdog',
    async run({ createExperiment, fleet }) {
      // Se necesita el modo PID: en MANUAL no hay watchdog (ver manualFailsafeGap).
      await createExperiment({
        case_type: 'closed_loop', plant_target: 'planta_2', controller_type: 'pid',
        setpoint_do: 5.0, parameters: {}
      });
      await waitFor(() => fleet.odrive.loopState().mode === 0, 15000,
        `El aireador debe quedar en PID (mode=${fleet.odrive.loopState().mode})`);

      fleet.sensor.setTrueDo(2.0);
      await waitFor(() => fleet.odrive.acceptedSamples >= 2, 30000, 'que lleguen muestras válidas');
      const doBefore = fleet.odrive.engine.getLastMeasuredDo();
      assertTrue(doBefore > 0, `La variable de proceso debe tener un valor real (tiene ${doBefore})`);

      fleet.sensor.setFault('noResponse');
      const rejectedBefore = fleet.odrive.rejectedSamples;
      await waitFor(() => fleet.odrive.rejectedSamples > rejectedBefore, 30000,
        'que el ODrive reciba paquetes marcados como inválidos (ceros + bit 22)');

      const st = fleet.odrive.loopState();
      assertTrue(st.rejected > 0, `Debe haber muestras rechazadas (${st.rejected})`);
      assertTrue(fleet.odrive.engine.getLastMeasuredDo() === doBefore,
        `El cero fantasma NO debe entrar al lazo: la variable pasó de ${doBefore} a ${fleet.odrive.engine.getLastMeasuredDo()}`);

      await waitFor(() => fleet.odrive.loopState().failsafe, 50000, 'que se active el watchdog de 35 s');
      assertTrue(fleet.odrive.loopState().targetRpm === 0, 'El watchdog debe dejar el motor a 0 RPM');
      assertTrue(fleet.odrive.engine.getLastMeasuredDo() === doBefore, 'La variable de proceso sigue sin contaminarse');

      fleet.sensor.setFault('none');
      return [
        `${st.rejected} muestras rechazadas`,
        'el cero fantasma no entró al lazo',
        'watchdog de 35 s a 0 RPM'
      ];
    }
  },

  /** Ingesta: la telemetría simulada debe persistir de verdad en la base de datos. */
  ingestion: {
    description: 'Ingesta bulk: la telemetría de los nodos llega a la base de datos',
    async run({ api, fleet, store, snapshot, args }) {
      const res = await api.post('/api/system/state', { state: 'ACTIVE_EXPERIMENT', requested_by: 'Banco virtual' });
      assertTrue(res.ok, `No se pudo activar el experimento (HTTP ${res.status})`);

      // 12 s cubre el flush de 5 s del sensor y dos del ODrive.
      await waitFor(() => fleet.sensor.telemetryCount >= 2 && fleet.odrive.telemetryCount >= 2, 40000,
        'que sensor y ODrive envíen al menos 2 lotes');

      const pushErrors = [...fleet.sensor.errors, ...fleet.odrive.errors].filter(e => e.includes('push'));
      assertTrue(pushErrors.length === 0, `Fallos al empujar telemetría: ${pushErrors.join(' | ')}`);

      const evidence = [`sensor: ${fleet.sensor.telemetryCount} lotes`, `odrive: ${fleet.odrive.telemetryCount} lotes`];

      if (store.available && snapshot) {
        const sensorRows = await store.countCreated('sensor_readings', snapshot.sensor_readings);
        const motorRows = await store.countCreated('motor_telemetry', snapshot.motor_telemetry);
        assertTrue(sensorRows !== null && sensorRows > 0,
          `sensor_readings no recibió filas nuevas (${sensorRows})`);
        assertTrue(motorRows !== null && motorRows > 0,
          `motor_telemetry no recibió filas nuevas (${motorRows})`);
        evidence.push(`sensor_readings +${sensorRows} filas`, `motor_telemetry +${motorRows} filas`);
      } else {
        evidence.push('verificación de BD omitida (sin credenciales)');
      }
      return evidence;
    }
  },

  /**
   * Alineación de canal: ESP-NOW comparte radio y canal con WiFi. Si el receptor no sigue al AP,
   * TODOS los paquetes se pierden en silencio. Se comprueba que el modelo lo detecta.
   */
  channelAlignment: {
    description: 'ESP-NOW: un canal desalineado pierde el 100% de los paquetes',
    async run({ link, fleet }) {
        await waitFor(() => link.stats.delivered > 0, 25000, 'que llegue un paquete con el canal alineado');
        const deliveredAligned = link.stats.delivered;

        // El AP cambia de canal y el receptor NO se re-alinea (fallo real del banco)
        link.setApChannel(6, { realignReceiver: false });
        const droppedBefore = link.stats.droppedChannel;
        for (let i = 0; i < 3; i++) fleet.sensor.measureOnce();
        await sleep(500);

        assertTrue(link.stats.droppedChannel > droppedBefore,
          'Un canal desalineado debe descartar los paquetes (no entregarlos en silencio)');
        assertTrue(link.stats.delivered === deliveredAligned,
          `Ningún paquete debe entregarse con el canal desalineado (llegaron ${link.stats.delivered - deliveredAligned})`);

        // Re-alineación: lo que ocurre cuando el AP fija el canal y el nodo sigue
        link.setApChannel(6, { realignReceiver: true });
        fleet.sensor.measureOnce();
        await waitFor(() => link.stats.delivered > deliveredAligned, 5000, 'que se recupere el enlace tras re-alinear');

        return ['canal alineado entrega', 'canal desalineado descarta el 100%', 'la re-alineación recupera el enlace'];
    }
  },

  /**
   * Anclaje por desfase de reloj: en el banco se midió +7..+16 s de skew en el mixer. El backend
   * debe detectarlo y anclar al servidor en vez de graficar la perturbación en el instante erróneo.
   */
  clockSkew: {
    description: 'Desfase de reloj: el backend detecta el skew y ancla al servidor',
    async run({ api, fleet, devices }) {
        fleet.odrive.clock.skewMs = 12000; // desfase inyectado en el nodo

        const res = await api.post('/api/commands', {
          device_id: devices.odrive.id,
          command_type: 'set_speed',
          speed_percent: 10,
          payload: { action: 'force_on', manual_throttle_pct: 10 },
          requested_by: 'Banco virtual (skew)'
        });
        assertTrue(res.ok, `No se pudo encolar el comando (HTTP ${res.status})`);
        await expectAction(fleet.odrive, 'force_on');

        await waitFor(() => fleet.odrive.acked.some(a => a.body && a.body.clock_skew_ms !== undefined), 20000,
          'que el ACK reporte clock_skew_ms');
        const ack = fleet.odrive.acked.find(a => a.body && a.body.clock_skew_ms !== undefined);
        const skew = Number(ack.body.clock_skew_ms);

        assertTrue(Math.abs(skew) > 5000, `El backend debe detectar el desfase de 12 s (reportó ${skew} ms)`);
        assertTrue(ack.body.clock_reliable === false,
          `Con |skew| > 5 s la marca debe ser false (llegó ${ack.body.clock_reliable})`);

        fleet.odrive.clock.skewMs = 0;
        return [`skew detectado: ${skew} ms`, 'clock_reliable=false', 'el backend anclará al servidor'];
    }
  }
};

/* ================================= Runner ================================= */

class Bench {
  constructor(args) {
    this.args = args;
    this.api = new ApiClient(args.baseUrl, args.verbose);
    this.store = new Store(resolveSupabaseCreds());

    // Planta sintética: da realimentación observable (aireador sube OD, sulfito lo baja) para poder
    // comprobar que el sistema completo trabaja coordinado. Parámetros de transferencia INVENTADOS:
    // su salida no es evidencia experimental ni sirve para validar ganancias.
    this.process = new ProcessModel({
      volumeL: 87.5,                 // volumen activo del banco (regla 10)
      initialDoMgL: args.initialDoMgL ?? 7.5,
      tempC: 24.0,
      timeAcceleration: args.timeAcceleration ?? 1.0
    });

    const built = buildFleet(this.api, args.verbose, { ...(args.simOptions || {}), process: this.process });
    this.fleet = built.fleet;
    // La planta se expone junto a la flota para que los escenarios la lean de forma natural.
    this.fleet.process = this.process;
    this.link = built.link;

    this.createdExperiments = [];
    this.previousState = null;
    this.snapshot = null;
    this.results = [];
    this.processTimer = null;
  }

  /** Hace evolucionar la planta a 5 Hz de tiempo real. */
  startProcess() {
    const dt = 0.2;
    this.processTimer = setInterval(() => {
      try { this.process.step(dt); } catch (err) { console.warn('   ! planta:', err.message); }
    }, dt * 1000);
  }

  /** Los 4 nodos virtuales (excluye la planta, que vive junto a ellos en `fleet`). */
  nodes() { return NODE_ROLES.map(r => this.fleet[r]); }

  deviceInfo(role) {
    return require('./config').DEVICES[role];
  }

  /** Comprueba el objetivo y evita interferir con un ensayo real. */
  async preflight() {
    const res = await this.api.get('/api/system/state');
    assertTrue(res.ok, `No se pudo leer /api/system/state (HTTP ${res.status}). ¿Está arriba ${this.args.baseUrl}?`);
    this.previousState = res.body.state;

    if (this.previousState.state !== 'IDLE' && !this.args.force) {
      throw new Error(
        `El orquestador está en '${this.previousState.state}' (experimento: ${this.previousState.experiment_id || 'ninguno'}). ` +
        `El banco virtual no debe correr sobre un ensayo real. Usa --force para forzarlo.`
      );
    }
    console.log(`   objetivo: ${this.args.baseUrl}`);
    console.log(`   estado previo: ${this.previousState.state}`);
    console.log(`   credenciales BD: ${this.store.available ? 'sí (verificación de persistencia activa)' : 'no (solo se verifica el transporte)'}`);
  }

  async createExperiment(body) {
    const res = await this.api.post('/api/experiments', {
      name: `[BANCO VIRTUAL] ${body.case_type}`,
      sampling_rate_sec: 5,
      csv_filename: 'VIRT_BENCH.CSV',
      ...body
    });
    assertTrue(res.ok, `POST /api/experiments falló (HTTP ${res.status}): ${JSON.stringify(res.body)?.slice(0, 200)}`);
    const exp = { ...res.body.experiment, armed: res.body.armed || [] };
    this.createdExperiments.push(exp.id);
    for (const node of this.nodes()) node.setExperiment(exp.id);
    return exp;
  }

  /** Restaura el estado previo, borra experimentos de prueba y limpia las filas creadas. */
  async restore() {
    console.log('\n--- Restauración ---');
    try {
      if (this.previousState) {
        const res = await this.api.post('/api/system/state', {
          state: this.previousState.state,
          requested_by: 'Banco virtual (restauración)'
        });
        console.log(`   system_state restaurado a ${this.previousState.state}: HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`   ! No se pudo restaurar el estado: ${e.message}`);
    }

    for (const id of this.createdExperiments) {
      const res = await require('./transport').request(`${this.args.baseUrl}/api/experiments/${id}`, {
        method: 'DELETE', body: {}
      });
      console.log(`   experimento ${id} eliminado: HTTP ${res.status}`);
    }

    if (!this.args.keepData) {
      const out = await this.store.cleanup(this.snapshot);
      console.log(`   filas creadas por el banco borradas: ${out.deleted}${out.tables.length ? ` (${out.tables.join(', ')})` : ''}`);
    } else {
      console.log('   --keep-data: las filas del banco se conservan a propósito');
    }

    if (this.store.missingTables.length) {
      const unique = [...new Set(this.store.missingTables)];
      console.log(`   tablas ausentes (migración pendiente): ${unique.join(', ')}`);
    }
  }

  async runScenario(name) {
    const scenario = SCENARIOS[name];
    assertTrue(scenario, `Escenario desconocido: '${name}'. Disponibles: ${Object.keys(SCENARIOS).join(', ')}`);

    // Aísla cada escenario: se descarta lo observado en el anterior y se vacían los comandos
    // pendientes. Sin este drenaje, un residuo de la corrida previa (p. ej. el `set_state IDLE` de
    // la restauración) se entrega primero — cada poll devuelve un solo comando — y ensucia las
    // aserciones de intención.
    for (const node of this.nodes()) {
      node.received = [];
      node.acked = [];
      node.errors = [];
    }
    for (const node of this.nodes()) {
      const n = await node.drainCommands();
      if (n > 0 && this.args.verbose) console.log(`   (${node.role}: ${n} comandos obsoletos descartados)`);
    }

    console.log(`\n[${name}] ${scenario.description}`);
    try {
      const evidence = await scenario.run({
        api: this.api,
        fleet: this.fleet,
        link: this.link,
        process: this.process,
        store: this.store,
        snapshot: this.snapshot,
        args: this.args,
        sleep,
        waitFor,
        devices: {
          sensor: this.deviceInfo('sensor'),
          odrive: this.deviceInfo('odrive'),
          mixer: this.deviceInfo('mixer'),
          pump: this.deviceInfo('pump')
        },
        createExperiment: (b) => this.createExperiment(b)
      });

      // Aserción transversal: ningún nodo debe haber recibido órdenes de otro rol.
      for (const node of [this.fleet.sensor, this.fleet.odrive, this.fleet.mixer, this.fleet.pump]) {
        expectNoForeignActions(node);
      }

      this.results.push({ name, ok: true, evidence });
      console.log(`  ✓ PASS  (${evidence.join(' · ')})`);
    } catch (err) {
      this.results.push({ name, ok: false, error: err.message });
      console.log(`  ✗ FAIL  ${err.message}`);
      if (this.args.verbose) console.log(err.stack);
    } finally {
      // Saneamiento obligatorio: un fallo no debe dejar el sensor averiado ni un reloj desfasado,
      // porque eso haría fallar en cascada a los escenarios siguientes.
      this.fleet.sensor.setFault('none');
      this.fleet.odrive.clock.skewMs = 0;
      this.link.setApChannel(this.link.channel, { realignReceiver: true });
    }
  }

  async run() {
    console.log('====================================================');
    console.log(' BANCO DE PRUEBAS VIRTUAL — contrato de orquestación ');
    console.log('====================================================');
    await this.preflight();

    this.snapshot = await this.store.snapshot();
    for (const node of this.nodes()) node.start();
    this.startProcess();
    console.log('   flota virtual en marcha (sensor, odrive, mixer, bomba)');
    console.log(`   planta sintética: OD inicial ${this.process.doMgL.toFixed(2)} mg/L, saturación ${this.process.saturation.toFixed(2)} mg/L a ${this.process.tempC} °C`);
    console.log(`   ⚠ parámetros de transferencia INVENTADOS (KLa_max=${UNIDENTIFIED.KLA_MAX_PER_S}/s): la salida es de plausibilidad, no evidencia experimental`);

    // Da tiempo a un primer polling para que los nodos existan ante el servidor.
    await sleep(CADENCE.commandPollMs + 500);

    const names = this.args.scenario === 'all' ? Object.keys(SCENARIOS) : [this.args.scenario];
    try {
      for (const name of names) await this.runScenario(name);
    } finally {
      for (const node of this.nodes()) node.stop();
      if (this.processTimer) { clearInterval(this.processTimer); this.processTimer = null; }
      await this.restore();
    }

    // Informe final
    console.log('\n==================== RESULTADOS ====================');
    const passed = this.results.filter(r => r.ok).length;
    for (const r of this.results) {
      console.log(` ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(16)} ${r.ok ? r.evidence.join(' · ') : r.error}`);
    }
    console.log('====================================================');
    console.log(` ${passed}/${this.results.length} escenarios OK`);
    console.log('====================================================');

    // Resumen de observaciones por nodo (útil cuando algo falla).
    if (this.results.some(r => !r.ok) || this.args.verbose) {
      console.log('\n--- Comandos vistos por nodo ---');
      for (const node of this.nodes()) {
        console.log(`  ${node.role}: [${node.actionsSeen().join(', ') || 'ninguna'}] (${node.received.length} comandos)`);
      }
    }

    return passed === this.results.length;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Banco de pruebas virtual de AquaControl

  --scenario <nombre>   ${['all', ...Object.keys(SCENARIOS)].join(' | ')}
  --target <prod|local|URL>
  --time-scale <n>      acelera el tiempo simulado de la planta (por defecto 1)
  --initial-do <mg/L>   OD inicial de la planta
  --keep-data           no borrar las filas creadas (por defecto se limpian)
  --force               correr aunque el orquestador no esté en IDLE
  --verbose             trazas detalladas

NOTA: no hay lazo cerrado. La planta sintética solo da una realimentación PLAUSIBLE para observar
que el sistema completo trabaja coordinado; sus parámetros de transferencia son INVENTADOS y su
salida no es evidencia experimental.
`);
    return 0;
  }

  if (args.dryRun) {
    console.log('--dry-run: el banco necesita escribir para validar la ingesta. Se ignora y se ejecuta igual.');
  }

  const bench = new Bench(args);
  const ok = await bench.run();
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\nFALLO CRÍTICO: ${err.message}`);
    process.exit(2);
  });
}

module.exports = { Bench, SCENARIOS, waitFor, expectAction };
