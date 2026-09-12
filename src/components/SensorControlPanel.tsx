'use client';

import React, { useState, useEffect } from 'react';
import {
  Activity,
  Play,
  Square,
  Zap,
  Moon,
  Clock,
  Send,
  AlertTriangle,
  CheckCircle2,
  Sliders,
  PowerOff,
  RefreshCw,
  Info,
  Radio,
  Timer
} from 'lucide-react';
import { Device, SensorCommandAction, SensorCommandPayload } from '@/types';

interface SensorControlPanelProps {
  sensorDevice: Device | null;
  onCommandSent: () => void;
}

export const SensorControlPanel: React.FC<SensorControlPanelProps> = ({
  sensorDevice,
  onCommandSent
}) => {
  const isDeviceOnline = sensorDevice?.status === 'online';
  const targetDeviceId = sensorDevice?.id || 'a0000000-0000-0000-0000-000000000001';

  // 1. Estado de Modo Monitor y Frecuencia de Muestreo (Sampling Rate)
  const initialMonitorActive = Boolean(sensorDevice?.metadata?.monitor_active ?? false);
  const initialMonitorInterval = Number(sensorDevice?.metadata?.monitor_interval_sec ?? 5);
  const initialSleepCycle = Number(sensorDevice?.metadata?.sleep_cycle_min ?? 15);

  const [isMonitorActive, setIsMonitorActive] = useState<boolean>(initialMonitorActive);
  const [monitorIntervalSec, setMonitorIntervalSec] = useState<number>(initialMonitorInterval);

  // 2. Estado de Ciclo de Sueño Autónomo (Sleep Cycle)
  const [sleepCycleMin, setSleepCycleMin] = useState<number>(initialSleepCycle);

  // 3. Estado de Suspensión Directa (Deep Sleep)
  const [sleepDurationMin, setSleepDurationMin] = useState<number>(30);
  const [isIndefiniteSleep, setIsIndefiniteSleep] = useState<boolean>(false);
  const [showIndefiniteConfirm, setShowIndefiniteConfirm] = useState<boolean>(false);

  // 4. Estados de Envío y Feedback
  const [isSending, setIsSending] = useState<boolean>(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info' | null; message: string }>({
    type: null,
    message: ''
  });

  const feedbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  // Sincronizar estado cuando los metadatos del sensor llegan o se actualizan desde el servidor
  const hasInitializedRef = React.useRef<boolean>(false);
  useEffect(() => {
    if (sensorDevice?.metadata && !hasInitializedRef.current) {
      if (sensorDevice.metadata.monitor_active !== undefined) {
        setIsMonitorActive(Boolean(sensorDevice.metadata.monitor_active));
      }
      if (sensorDevice.metadata.monitor_interval_sec) {
        setMonitorIntervalSec(Number(sensorDevice.metadata.monitor_interval_sec));
      }
      if (sensorDevice.metadata.sleep_cycle_min) {
        setSleepCycleMin(Number(sensorDevice.metadata.sleep_cycle_min));
      }
      hasInitializedRef.current = true;
    }
  }, [sensorDevice?.metadata]);

  const showFeedback = (type: 'success' | 'error' | 'info', message: string) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback({ type, message });
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback({ type: null, message: '' });
    }, 6000);
  };

  // Función genérica para despachar comandos al sensor
  const sendSensorCommand = async (
    action: SensorCommandAction,
    payloadData: Partial<SensorCommandPayload> = {},
    commandType: 'start' | 'stop' | 'set_config' = 'set_config',
    successMsg: string = 'Comando enviado exitosamente'
  ) => {
    setIsSending(true);
    setActiveAction(action);
    setFeedback({ type: null, message: '' });

    try {
      const fullPayload: SensorCommandPayload = {
        action,
        ...payloadData
      };

      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: targetDeviceId,
          command_type: commandType,
          payload: fullPayload,
          requested_by: `Operador Web (${action})`
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al comunicar con el servidor');

      const offlineNotice = !isDeviceOnline 
        ? ' [Encolado: se aplicará en el próximo despertar del sensor]' 
        : '';
      showFeedback('success', `${successMsg}${offlineNotice}`);
      onCommandSent();
    } catch (err: any) {
      showFeedback('error', err.message || 'Error de conexión con el servidor');
    } finally {
      setIsSending(false);
      setActiveAction(null);
    }
  };

  // 1. Acciones de Modo Monitor
  const handleToggleMonitor = async (targetActive: boolean) => {
    const action: SensorCommandAction = targetActive ? 'start_monitor' : 'stop_monitor';
    const commandType = targetActive ? 'start' : 'stop';
    await sendSensorCommand(
      action,
      { interval_sec: monitorIntervalSec },
      commandType,
      targetActive ? `Modo Monitor iniciado (muestreo cada ${monitorIntervalSec}s)` : 'Modo Monitor detenido'
    );
    setIsMonitorActive(targetActive);
  };

  const handleUpdateSamplingRate = async (newInterval: number) => {
    setMonitorIntervalSec(newInterval);
    if (isMonitorActive) {
      await sendSensorCommand(
        'set_sampling_rate',
        { interval_sec: newInterval },
        'set_config',
        `Frecuencia de muestreo actualizada a ${newInterval}s`
      );
    }
  };

  // 2. Muestreo Manual Inmediato
  const handleManualSample = async () => {
    await sendSensorCommand(
      'manual_sample',
      {},
      'set_config',
      'Muestreo manual ejecutado. Lectura transmitida al servidor.'
    );
  };

  // 3. Ciclo de Medición Programada (Sleep Cycle)
  const handleApplySleepCycle = async () => {
    await sendSensorCommand(
      'set_sleep_cycle',
      { measure_time_min: sleepCycleMin },
      'set_config',
      `Ciclo de medición programado configurado a ${sleepCycleMin} minutos`
    );
  };

  // 4. Suspensión / Deep Sleep
  const handleTriggerSleep = async () => {
    if (isIndefiniteSleep && !showIndefiniteConfirm) {
      setShowIndefiniteConfirm(true);
      return;
    }

    setShowIndefiniteConfirm(false);
    const minutes = isIndefiniteSleep ? 0 : sleepDurationMin;
    await sendSensorCommand(
      'sleep',
      { minutes, indefinite: isIndefiniteSleep },
      'set_config',
      isIndefiniteSleep
        ? 'Sensor suspendido indefinidamente. Reactivación mediante botón RST/EN.'
        : `Sensor puesto en suspensión profunda por ${minutes} minutos.`
    );
    setIsMonitorActive(false);
  };

  const intervalPresets = [1, 2, 5, 10, 15, 30];
  const sleepCyclePresets = [5, 10, 15, 30, 60];
  const timedSleepPresets = [15, 30, 60, 120];

  return (
    <div className="glass-panel rounded-2xl p-5 border border-slate-800/80 bg-slate-900/50 backdrop-blur-md relative overflow-hidden flex flex-col gap-5 shadow-xl">
      {/* Glow ambiental de fondo */}
      <div className="absolute top-0 right-0 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Cabecera del Panel */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-950/80 border border-cyan-800/60 text-cyan-400 shadow-md">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-white tracking-wide">
                Control del Sensor Óptico (OD-Logger)
              </h3>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                isDeviceOnline
                  ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800/60'
                  : 'bg-amber-950/80 text-amber-400 border-amber-800/60'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isDeviceOnline ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                {isDeviceOnline ? 'Enlace Activo' : 'En Espera / Dormido'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Aqualabo DIGISENS • RS-485 Modbus • Enlace ESP-NOW / WiFi
            </p>
          </div>
        </div>

        {/* Estado actual del modo de operación */}
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold ${
            isMonitorActive
              ? 'bg-cyan-950/70 border-cyan-600/70 text-cyan-300 shadow-cyan-900/20 shadow-lg'
              : 'bg-slate-800/60 border-slate-700/60 text-slate-300'
          }`}>
            <Radio className={`w-3.5 h-3.5 ${isMonitorActive ? 'text-cyan-400 animate-spin' : 'text-slate-500'}`} />
            <span>
              {isMonitorActive ? `Modo Monitor (${monitorIntervalSec}s)` : `Ciclo Periódico (${sleepCycleMin}m)`}
            </span>
          </div>
        </div>
      </div>

      {/* Banner de Feedback Interactivo */}
      {feedback.type && (
        <div className={`p-3 rounded-xl border flex items-center gap-3 text-xs animate-in fade-in duration-200 ${
          feedback.type === 'success'
            ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
            : feedback.type === 'error'
            ? 'bg-rose-950/80 border-rose-800 text-rose-300'
            : 'bg-cyan-950/80 border-cyan-800 text-cyan-300'
        }`}>
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-400" />
          ) : feedback.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 flex-shrink-0 text-rose-400" />
          ) : (
            <Info className="w-4 h-4 flex-shrink-0 text-cyan-400" />
          )}
          <span className="flex-1 font-medium">{feedback.message}</span>
        </div>
      )}

      {/* Cuadrícula de Funcionalidades Principales */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        
        {/* ============================================================ */}
        {/* TARJETA 1: Modo Monitor (Start / Stop y Sampling Rate)        */}
        {/* ============================================================ */}
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5" /> Modo Monitor
              </span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${
                isMonitorActive ? 'bg-cyan-500/20 text-cyan-300' : 'bg-slate-800 text-slate-400'
              }`}>
                {isMonitorActive ? 'Activo' : 'Inactivo'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Mantiene la boya despierta para muestreo y visualización continua en pantalla OLED y gráficos.
            </p>
          </div>

          <div className="space-y-3">
            {/* Intervalo / Sampling Rate */}
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-slate-300">Frecuencia de Muestreo:</span>
                <strong className="text-cyan-300 font-mono">{monitorIntervalSec} seg</strong>
              </div>
              <input
                type="range"
                min="1"
                max="60"
                step="1"
                value={monitorIntervalSec}
                onChange={(e) => handleUpdateSamplingRate(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
              <div className="flex items-center justify-between gap-1 mt-1.5">
                {intervalPresets.map((val) => (
                  <button
                    key={val}
                    onClick={() => handleUpdateSamplingRate(val)}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
                      monitorIntervalSec === val
                        ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {val}s
                  </button>
                ))}
              </div>
            </div>

            {/* Botones Iniciar / Detener */}
            <div className="pt-1">
              {isMonitorActive ? (
                <button
                  onClick={() => handleToggleMonitor(false)}
                  disabled={isSending}
                  className="w-full py-2 px-3 rounded-lg font-semibold text-xs text-rose-200 bg-rose-950/80 hover:bg-rose-900 border border-rose-800 transition-all flex items-center justify-center gap-2 shadow-sm"
                >
                  <Square className="w-3.5 h-3.5 fill-rose-300" />
                  <span>Detener Muestreo Continuo</span>
                </button>
              ) : (
                <button
                  onClick={() => handleToggleMonitor(true)}
                  disabled={isSending}
                  className="w-full py-2 px-3 rounded-lg font-semibold text-xs text-cyan-950 bg-gradient-to-r from-cyan-400 to-teal-400 hover:from-cyan-300 hover:to-teal-300 transition-all flex items-center justify-center gap-2 shadow-md shadow-cyan-500/20"
                >
                  <Play className="w-3.5 h-3.5 fill-cyan-950" />
                  <span>Iniciar Modo Monitor ({monitorIntervalSec}s)</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* TARJETA 2: Muestreo Inmediato (Manual Sample)                 */}
        {/* ============================================================ */}
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" /> Muestreo Manual
              </span>
              <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full font-mono">
                Puntual
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Fuerza una lectura inmediata del sensor DIGISENS, registrándola en EEPROM/SD y publicándola a Supabase.
            </p>
          </div>

          <div className="space-y-2">
            <div className="p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-[11px] text-slate-400 flex items-start gap-2">
              <Info className="w-4 h-4 text-amber-400/80 flex-shrink-0 mt-0.5" />
              <span>Ideal para verificar el estado del agua sin alterar el ciclo de bajo consumo programado.</span>
            </div>

            <button
              onClick={handleManualSample}
              disabled={isSending}
              className="w-full py-2.5 px-3 rounded-lg font-semibold text-xs text-amber-200 bg-amber-950/80 hover:bg-amber-900 border border-amber-800/80 transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${activeAction === 'manual_sample' ? 'animate-spin' : ''}`} />
              <span>{activeAction === 'manual_sample' ? 'Muestreando...' : 'Tomar Muestra Inmediata'}</span>
            </button>
          </div>
        </div>

        {/* ============================================================ */}
        {/* TARJETA 3: Ciclos de Medición Programada (Sleep Cycles)       */}
        {/* ============================================================ */}
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <Timer className="w-3.5 h-3.5" /> Ciclo de Sueño
              </span>
              <span className="text-[10px] bg-emerald-950/80 text-emerald-300 px-2 py-0.5 rounded-full font-mono">
                {sleepCycleMin} min
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Intervalo autónomo en el que el ESP32 despierta, toma muestra, sincroniza telemetría y vuelve a dormir.
            </p>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-slate-300">Despertar cada:</span>
                <strong className="text-emerald-300 font-mono">{sleepCycleMin} minutos</strong>
              </div>
              <div className="grid grid-cols-5 gap-1">
                {sleepCyclePresets.map((min) => (
                  <button
                    key={min}
                    onClick={() => setSleepCycleMin(min)}
                    className={`py-1 rounded text-[11px] font-mono text-center transition-colors ${
                      sleepCycleMin === min
                        ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/60 font-bold'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {min}m
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleApplySleepCycle}
              disabled={isSending}
              className="w-full py-2 px-3 rounded-lg font-semibold text-xs text-emerald-200 bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-800 transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Guardar Ciclo Programado</span>
            </button>
          </div>
        </div>

        {/* ============================================================ */}
        {/* TARJETA 4: Suspensión Directa (Deep Sleep: Timed / Indefinite)*/}
        {/* ============================================================ */}
        <div className="p-4 rounded-xl border border-slate-800 bg-slate-950/40 flex flex-col justify-between gap-4">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-400 flex items-center gap-1.5">
                <Moon className="w-3.5 h-3.5" /> Suspender Sensor
              </span>
              <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full font-mono">
                Bajo Consumo
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              Fuerza la transición a sueño profundo para conservar batería o trasladar la boya.
            </p>
          </div>

          <div className="space-y-2.5">
            {/* Toggle indefinido vs temporizado */}
            <div className="flex items-center justify-between p-2 rounded-lg bg-slate-900/90 border border-slate-800 text-xs">
              <span className="text-slate-300 font-medium">Sueño Indefinido:</span>
              <button
                type="button"
                onClick={() => {
                  setIsIndefiniteSleep(!isIndefiniteSleep);
                  setShowIndefiniteConfirm(false);
                }}
                className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  isIndefiniteSleep ? 'bg-indigo-600' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    isIndefiniteSleep ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Selector de minutos si no es indefinido */}
            {!isIndefiniteSleep ? (
              <div className="grid grid-cols-4 gap-1">
                {timedSleepPresets.map((m) => (
                  <button
                    key={m}
                    onClick={() => setSleepDurationMin(m)}
                    className={`py-1 rounded text-[10px] font-mono text-center transition-colors ${
                      sleepDurationMin === m
                        ? 'bg-indigo-500/30 text-indigo-300 border border-indigo-500/60 font-bold'
                        : 'bg-slate-800/80 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m}m
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-2 rounded bg-indigo-950/60 border border-indigo-900/60 text-[10px] text-indigo-300 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                <span>Requiere botón físico RST en la boya para despertar.</span>
              </div>
            )}

            {/* Confirmación modal para sueño indefinido */}
            {showIndefiniteConfirm ? (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] text-amber-300 font-bold text-center">
                  ¿Confirmar apagado total de temporizadores?
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={handleTriggerSleep}
                    className="py-1.5 px-2 rounded bg-rose-600 hover:bg-rose-500 text-white font-bold text-[11px]"
                  >
                    Sí, Suspender
                  </button>
                  <button
                    onClick={() => setShowIndefiniteConfirm(false)}
                    className="py-1.5 px-2 rounded bg-slate-800 text-slate-300 text-[11px]"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={handleTriggerSleep}
                disabled={isSending}
                className="w-full py-2 px-3 rounded-lg font-semibold text-xs text-indigo-200 bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-800 transition-all flex items-center justify-center gap-2 shadow-sm"
              >
                <PowerOff className="w-3.5 h-3.5" />
                <span>
                  {isIndefiniteSleep ? 'Dormir Indefinidamente' : `Suspender por ${sleepDurationMin} min`}
                </span>
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
