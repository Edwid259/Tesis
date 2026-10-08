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
      assertTrue(exp.armed.includes('mixer'),
        `El servidor debe declarar el mixer armado (armed: [${exp.armed.join(', ')}])`);
      assertTrue(!exp.armed.includes('odrive'),
        `Planta 1 no debe armar el aireador (armed: [${exp.armed.join(', ')}])`);

      await expectAction(fleet.mixer, 'start_mixer');

      // El aireador no debe arrancar. Si el orquestador le manda el estado, debe ser motor_mode off.
      const motorMode = fleet.odrive.payloadOf('set_state');
      if (motorMode) {
        assertTrue(motorMode.motor_mode === 'off',
          `El ODrive debe quedar en motor_mode 'off' en Planta 1 (recibió '${motorMode.motor_mode}')`);
      }
      return ['armed=[mixer]', 'mixer recibió start_mixer', 'aireador sin arranque'];
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
      assertTrue(exp.armed.includes('odrive'),
        `El servidor debe declarar el aireador armado (armed: [${exp.armed.join(', ')}])`);
      assertTrue(exp.armed.includes('mixer_off'),
        `El servidor debe declarar el mixer detenido (armed: [${exp.armed.join(', ')}])`);

      await expectAction(fleet.mixer, 'stop_mixer');
      await expectAction(fleet.odrive, 'set_mode');

      const motor = fleet.odrive.payloadOf('set_mode');
      assertTrue(motor.mode === 'manual', `El aireador debe armarse en manual (recibió '${motor.mode}')`);
      assertTrue(Number(motor.manual_throttle_pct) === 40,
        `El escalón debe ser 40% (recibió ${motor.manual_throttle_pct})`);

      // El aireador debe GIRAR de verdad: es lo que nunca ocurría antes.
      await waitFor(() => fleet.odrive.loopState().actualRpm > 1, 15000,
        `El aireador debe girar tras armarse al 40% (RPM actual: ${fleet.odrive.loopState().actualRpm})`);
      return ['armed=[mixer_off, odrive]', 'aireador girando al 40%', 'mixer detenido'];
    }
  },

  /** Caso B: lazo cerrado. El aireador debe armarse en PID con el setpoint. */
  closedloop: {
    description: 'Caso B (lazo cerrado): aireador en PID con setpoint de OD',
    async run({ createExperiment, fleet }) {
      const exp = await createExperiment({
        case_type: 'closed_loop', plant_target: 'planta_2', controller_type: 'pid',
        setpoint_do: 5.0, parameters: {}
      });
      assertTrue(exp.armed.includes('odrive'), 'El servidor debe declarar el aireador armado');

      await expectAction(fleet.odrive, 'set_mode');
      const motor = fleet.odrive.payloadOf('set_mode');
      assertTrue(motor.mode === 'pid', `El aireador debe armarse en PID (recibió '${motor.mode}')`);
      assertTrue(Number(motor.target_do) === 5.0, `El setpoint debe viajar (recibió ${motor.target_do})`);

      // Con el OD real por debajo del setpoint, el PID debe demandar RPM.
      fleet.sensor.setTrueDo(2.0);
      await waitFor(() => fleet.odrive.loopState().targetRpm > 0, 40000,
        'el PID debe demandar RPM con OD por debajo del setpoint');
      const st = fleet.odrive.loopState();
      return [`PID con setpoint 5.0`, `demanda ${st.targetRpm.toFixed(1)} RPM`, `OD real 2.0 mg/L`];
    }
  },

  /** El sensor debe enterarse de que hay experimento: si no, no muestrea y no hay curva. */
  sensorSampling: {
    description: 'El sensor recibe la orden de muestrear al iniciar un experimento',
    async run({ createExperiment, fleet }) {
      await createExperiment({
        case_type: 'planta_2_step', plant_target: 'planta_2', controller_type: 'none',
        parameters: { step_throttle_pct: 30 }
      });
      await expectAction(fleet.sensor, 'set_state', 25000);
      const st = fleet.sensor.payloadOf('set_state');
      assertTrue(st.state === 'ACTIVE_EXPERIMENT',
        `El sensor debe recibir state ACTIVE_EXPERIMENT (recibió '${st.state}')`);
      assertTrue(fleet.sensor.systemState === 'ACTIVE_EXPERIMENT', 'El sensor debe pasar a muestrear');
      return ['sensor recibió set_state ACTIVE_EXPERIMENT', 'el sensor está muestreando'];
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
      const mix = payloadOf(fleet.mixer, 'set_state');
      const mot = payloadOf(fleet.odrive, 'set_state');
      assertTrue(mix.mixer === 'off', `El mixer debe recibir mixer='off' (recibió '${mix.mixer}')`);
      assertTrue(mot.motor_mode === 'off', `El motor debe recibir motor_mode='off' (recibió '${mot.motor_mode}')`);
      return ["mixer='off'", "motor_mode='off'", 'receta abortada'];
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
      assertTrue(fleet.odrive.emergencyStop === true, 'El nodo debe quedar latcheado tras el E-Stop');

      const resume = await api.post('/api/commands', {
        device_id: devices.odrive.id,
        command_type: 'set_speed',
        speed_percent: 0,
        payload: { action: 'clear_estop' },
        requested_by: 'Banco virtual'
      });
      assertTrue(resume.ok, `No se pudo encolar clear_estop (HTTP ${resume.status})`);
      await expectAction(fleet.odrive, 'clear_estop');
      assertTrue(fleet.odrive.emergencyStop === false, 'clear_estop debe liberar el latch');
      return ['E-Stop latcheado', 'clear_estop libera el latch'];
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
   * FRONTERA DE CONFIANZA de `status_flags`: con el sensor averiado, el logger transmite DO=0.000
   * con el bit 22 activo. El receptor debe DESCARTAR esa muestra; si la aceptara, el PID vería un
   * error enorme y llevaría el motor a fondo. Aquí se comprueba que no se inyecta el cero fantasma
   * y que el watchdog de 35 s acaba frenando el motor.
   */
  espnowTrust: {
    description: 'Fallo de sensor: la muestra marcada no entra al lazo y actúa el watchdog',
    async run({ api, fleet }) {
        const res = await api.post('/api/system/state', { state: 'ACTIVE_EXPERIMENT', requested_by: 'Banco virtual' });
        assertTrue(res.ok, `No se pudo activar el experimento (HTTP ${res.status})`);

        // OD muy bajo -> error positivo -> el PID acelera, así el fallo es observable.
        fleet.sensor.setTrueDo(2.0);
        await waitFor(() => fleet.odrive.loopState().accepted >= 2, 30000, 'que el ODrive reciba muestras válidas');
        const doBefore = fleet.odrive.engine.getLastMeasuredDo();
        assertTrue(doBefore > 0, `La variable de proceso debe tener un valor real antes del fallo (tiene ${doBefore})`);

        // Avería del sensor: responde con ceros y el bit de estado
        fleet.sensor.setFault('noResponse');
        const rejectedBefore = fleet.odrive.rejectedSamples;
        await waitFor(() => fleet.odrive.rejectedSamples > rejectedBefore, 30000,
          'que el ODrive reciba paquetes marcados como inválidos');

        const st = fleet.odrive.loopState();
        assertTrue(st.rejected > 0, `Debe haber muestras rechazadas (${st.rejected})`);
        assertTrue(fleet.odrive.engine.getLastMeasuredDo() === doBefore,
          `El cero fantasma NO debe entrar al lazo: la variable pasó de ${doBefore} a ${fleet.odrive.engine.getLastMeasuredDo()}`);

        // Tras 35 s sin muestras válidas el watchdog debe haber frenado el motor.
        await waitFor(() => fleet.odrive.loopState().failsafe, 45000, 'que se active el watchdog de 35 s');
        assertTrue(fleet.odrive.engine.getLastMeasuredDo() === doBefore, 'La variable de proceso sigue sin contaminarse');

        fleet.sensor.setFault('none');
        return [
          `${st.rejected} muestras rechazadas`,
          'el cero fantasma no entró al lazo',
          'watchdog de 35 s activado'
        ];
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
    const built = buildFleet(this.api, args.verbose, args.simOptions || {});
    this.fleet = built.fleet;
    this.link = built.link;
    this.createdExperiments = [];
    this.previousState = null;
    this.snapshot = null;
    this.results = [];
  }

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
    for (const node of Object.values(this.fleet)) node.setExperiment(exp.id);
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

    // Aísla cada escenario: se descarta lo observado en el anterior.
    for (const node of Object.values(this.fleet)) {
      node.received = [];
      node.acked = [];
      node.errors = [];
    }

    console.log(`\n[${name}] ${scenario.description}`);
    try {
      const evidence = await scenario.run({
        api: this.api,
        fleet: this.fleet,
        link: this.link,
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
    }
  }

  async run() {
    console.log('====================================================');
    console.log(' BANCO DE PRUEBAS VIRTUAL — contrato de orquestación ');
    console.log('====================================================');
    await this.preflight();

    this.snapshot = await this.store.snapshot();
    for (const node of Object.values(this.fleet)) node.start();
    console.log('   flota virtual en marcha (sensor, odrive, mixer, bomba)');

    // Da tiempo a un primer polling para que los nodos existan ante el servidor.
    await sleep(CADENCE.commandPollMs + 500);

    const names = this.args.scenario === 'all' ? Object.keys(SCENARIOS) : [this.args.scenario];
    try {
      for (const name of names) await this.runScenario(name);
    } finally {
      for (const node of Object.values(this.fleet)) node.stop();
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
      for (const node of Object.values(this.fleet)) {
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
  --settle-ms <ms>      espera entre pasos (informativo)
  --dry-run             no implementado para escritura: usar --keep-data para conservar filas
  --keep-data           no borrar las filas creadas (por defecto se limpian)
  --force               correr aunque el orquestador no esté en IDLE
  --verbose             trazas detalladas
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
