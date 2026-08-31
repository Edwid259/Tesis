'use client';

import React, { useState, useEffect } from 'react';
import { Power, Send, Gauge, AlertCircle, CheckCircle2, ShieldAlert, Cpu } from 'lucide-react';
import { Device, MotorTelemetry } from '@/types';

interface MotorControlPanelProps {
  motorDevice: Device | null;
  currentTelemetry: MotorTelemetry | null;
  onCommandSent: () => void;
}

export const MotorControlPanel: React.FC<MotorControlPanelProps> = ({
  motorDevice,
  currentTelemetry,
  onCommandSent
}) => {
  const isDeviceOnline = motorDevice?.status === 'online';
  
  // Estado local del control
  const [isOn, setIsOn] = useState<boolean>(currentTelemetry?.is_on ?? false);
  const [targetSpeed, setTargetSpeed] = useState<number>(currentTelemetry?.speed_percent ?? 50);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | null; message: string }>({
    type: null,
    message: ''
  });

  // Sincronizar si cambia el telemetría externo y no estamos enviando
  useEffect(() => {
    if (currentTelemetry && !isSending) {
      setIsOn(currentTelemetry.is_on);
      if (currentTelemetry.speed_percent > 0) {
        setTargetSpeed(currentTelemetry.speed_percent);
      }
    }
  }, [currentTelemetry]);

  // Cálculo de PWM en microsegundos (Blue Robotics T200 / ESC Basic)
  // 0% -> 1500µs (Neutro / Stop)
  // 100% -> 1900µs (Avance Máximo)
  const estimatedPwm = !isOn ? 1500 : Math.round(1500 + (targetSpeed / 100) * 400);

  const handleTogglePower = () => {
    if (!isDeviceOnline) return;
    setIsOn(prev => !prev);
  };

  const handleApplyChanges = async () => {
    if (!isDeviceOnline) {
      setFeedback({
        type: 'error',
        message: 'No se puede enviar comandos: el ESP32 del motor está desconectado.'
      });
      return;
    }

    setIsSending(true);
    setFeedback({ type: null, message: '' });

    try {
      const commandType = isOn ? (targetSpeed > 0 ? 'set_speed' : 'stop') : 'stop';
      const speed = isOn ? targetSpeed : 0;

      const res = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: motorDevice?.id,
          command_type: commandType,
          speed_percent: speed,
          requested_by: 'Operador AquaControl'
        })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Error al enviar comando');
      }

      setFeedback({
        type: 'success',
        message: `¡Comando transmitido! Orden: ${commandType.toUpperCase()} (${speed}% | ${estimatedPwm}µs)`
      });

      onCommandSent();

      // Limpiar mensaje tras 4 segundos
      setTimeout(() => {
        setFeedback(prev => (prev.type === 'success' ? { type: null, message: '' } : prev));
      }, 4000);

    } catch (err: any) {
      setFeedback({
        type: 'error',
        message: err.message || 'Error de conexión con el servidor'
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="glass-panel rounded-2xl p-5 border border-cyan-900/40 relative overflow-hidden">
      {/* Glow background accent */}
      <div className="absolute -top-12 -left-12 w-48 h-48 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-3.5 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-blue-950/80 border border-blue-800/60">
            <Cpu className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span>Control del Aireador Thruster T200</span>
              {isDeviceOnline ? (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">
                  Listo
                </span>
              ) : (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-950 text-rose-400 border border-rose-800">
                  ESP32 Offline
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-400">
              Ajuste de velocidad porcentual y señal PWM para ESC de Blue Robotics
            </p>
          </div>
        </div>

        {/* Indicador de conexión */}
        {!isDeviceOnline && (
          <div className="flex items-center gap-1.5 text-xs text-rose-400 bg-rose-950/60 border border-rose-800/80 px-2.5 py-1 rounded-lg">
            <ShieldAlert className="w-4 h-4" />
            <span className="hidden sm:inline">Comandos deshabilitados</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-center">
        {/* Switch Encender / Apagar */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Interruptor de Potencia
          </label>
          <button
            onClick={handleTogglePower}
            disabled={!isDeviceOnline || isSending}
            className={`flex items-center justify-center gap-3 py-3 px-5 rounded-xl font-bold transition-all border shadow-lg ${
              !isDeviceOnline
                ? 'bg-slate-800/50 text-slate-500 border-slate-700 cursor-not-allowed'
                : isOn
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white border-emerald-400/50 shadow-emerald-900/30 active:scale-[0.98]'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700 active:scale-[0.98]'
            }`}
          >
            <Power className={`w-5 h-5 ${isOn ? 'text-white' : 'text-slate-400'}`} />
            <span>{isOn ? 'MOTOR ENCENDIDO' : 'MOTOR APAGADO'}</span>
          </button>
          <span className="text-[11px] text-slate-500 text-center">
            {isOn ? 'Impulsión activa en estanque' : 'Impulsor detenido en neutro (1500µs)'}
          </span>
        </div>

        {/* Slider de Velocidad */}
        <div className="flex flex-col gap-2">
          <div className="flex justify-between items-center">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1">
              <Gauge className="w-3.5 h-3.5 text-cyan-400" />
              <span>Velocidad de Flujo:</span>
            </label>
            <span className="text-sm font-bold text-cyan-300 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800/60">
              {isOn ? `${targetSpeed}%` : '0% (Inactivo)'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 font-bold">0%</span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={targetSpeed}
              disabled={!isDeviceOnline || !isOn || isSending}
              onChange={(e) => setTargetSpeed(Number(e.target.value))}
              className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed"
            />
            <span className="text-xs text-slate-500 font-bold">100%</span>
          </div>

          <div className="flex justify-between text-[11px] text-slate-400">
            <span>PWM Estimado: <strong className="text-cyan-400">{estimatedPwm} µs</strong></span>
            <span>Empuje Est.: <strong className="text-slate-300">{isOn ? ((targetSpeed / 100) * 5.25).toFixed(1) : 0} kgf</strong></span>
          </div>
        </div>

        {/* Botón Aplicar Cambios */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Confirmación de Mando
          </label>
          <button
            onClick={handleApplyChanges}
            disabled={!isDeviceOnline || isSending}
            className={`flex items-center justify-center gap-2 py-3 px-5 rounded-xl font-bold transition-all border shadow-lg ${
              !isDeviceOnline || isSending
                ? 'bg-slate-800/60 text-slate-500 border-slate-700 cursor-not-allowed'
                : 'bg-gradient-to-r from-cyan-600 via-blue-600 to-teal-600 hover:from-cyan-500 hover:to-teal-500 text-white border-cyan-400/40 shadow-cyan-900/30 active:scale-[0.98]'
            }`}
          >
            <Send className={`w-4 h-4 ${isSending ? 'animate-spin' : ''}`} />
            <span>{isSending ? 'Transmitiendo...' : 'Aplicar Cambios'}</span>
          </button>
          <span className="text-[11px] text-slate-500 text-center">
            Envía orden inmediata a la cola de comandos del ESP32
          </span>
        </div>
      </div>

      {/* Banner de Feedback */}
      {feedback.type && (
        <div className={`mt-4 p-3 rounded-xl flex items-center gap-2.5 text-xs font-medium border ${
          feedback.type === 'success'
            ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80'
            : 'bg-rose-950/80 text-rose-300 border-rose-800/80'
        }`}>
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}
    </div>
  );
};
