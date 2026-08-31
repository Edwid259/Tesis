'use client';

import React, { useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine
} from 'recharts';
import { HistoryDataPoint, SystemThresholds } from '@/types';
import { LineChart as ChartIcon, Eye, EyeOff, Calendar } from 'lucide-react';

interface ChartsSectionProps {
  history: HistoryDataPoint[];
  thresholds: SystemThresholds;
  selectedRange: string;
  onRangeChange: (range: string) => void;
  isLoading: boolean;
}

export const ChartsSection: React.FC<ChartsSectionProps> = ({
  history,
  thresholds,
  selectedRange,
  onRangeChange,
  isLoading
}) => {
  const [activeTab, setActiveTab] = useState<'combined' | 'do' | 'motor'>('combined');
  const [showDO, setShowDO] = useState<boolean>(true);
  const [showSpeed, setShowSpeed] = useState<boolean>(true);
  const [showTemp, setShowTemp] = useState<boolean>(true);

  const ranges = [
    { label: 'Última Hora', value: '1h' },
    { label: '24 Horas', value: '24h' },
    { label: '7 Días', value: '7d' }
  ];

  // Custom Tooltip estilizado
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-slate-950/95 border border-slate-700/80 p-3 rounded-xl shadow-2xl backdrop-blur-md text-xs">
          <p className="font-semibold text-slate-300 mb-1.5 border-b border-slate-800 pb-1 flex items-center justify-between gap-4">
            <span>Hora de lectura:</span>
            <span className="text-cyan-400">{label}</span>
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, index: number) => (
              <div key={`item-${index}`} className="flex items-center justify-between gap-3 font-medium">
                <span style={{ color: entry.color }} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  {entry.name}:
                </span>
                <span className="text-slate-100 font-bold">
                  {entry.value} {entry.unit || ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="glass-panel rounded-2xl p-5 border border-cyan-900/30 flex flex-col gap-5">
      {/* Controles de Gráfica: Pestañas de Vista y Selector de Rango */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        {/* Selector de tipo de gráfica */}
        <div className="flex items-center gap-1.5 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('combined')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'combined'
                ? 'bg-cyan-600 text-white shadow-md shadow-cyan-900/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Gráfica Combinada
          </button>
          <button
            onClick={() => setActiveTab('do')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'do'
                ? 'bg-cyan-600 text-white shadow-md shadow-cyan-900/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Oxígeno Disuelto (OD)
          </button>
          <button
            onClick={() => setActiveTab('motor')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'motor'
                ? 'bg-cyan-600 text-white shadow-md shadow-cyan-900/40'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Velocidad Aireador
          </button>
        </div>

        {/* Filtros de Rango Temporal */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
            {ranges.map((r) => (
              <button
                key={r.value}
                onClick={() => onRangeChange(r.value)}
                disabled={isLoading}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  selectedRange === r.value
                    ? 'bg-slate-700 text-cyan-300 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Toggles de Series para la Gráfica Combinada */}
      {activeTab === 'combined' && (
        <div className="flex flex-wrap items-center justify-between text-xs gap-3">
          <span className="text-slate-400 font-medium">Visibilidad de Series:</span>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setShowDO(!showDO)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-all ${
                showDO
                  ? 'bg-cyan-950/80 text-cyan-300 border-cyan-800'
                  : 'bg-slate-900 text-slate-500 border-slate-800 line-through'
              }`}
            >
              {showDO ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              <span>Oxígeno Disuelto (mg/L)</span>
            </button>

            <button
              onClick={() => setShowSpeed(!showSpeed)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-all ${
                showSpeed
                  ? 'bg-blue-950/80 text-blue-300 border-blue-800'
                  : 'bg-slate-900 text-slate-500 border-slate-800 line-through'
              }`}
            >
              {showSpeed ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              <span>Velocidad Thruster (%)</span>
            </button>

            <button
              onClick={() => setShowTemp(!showTemp)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border transition-all ${
                showTemp
                  ? 'bg-teal-950/80 text-teal-300 border-teal-800'
                  : 'bg-slate-900 text-slate-500 border-slate-800 line-through'
              }`}
            >
              {showTemp ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              <span>Temperatura (°C)</span>
            </button>
          </div>
        </div>
      )}

      {/* Contenedor de la Gráfica */}
      <div className="h-[340px] w-full pt-2">
        {history.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-2">
            <ChartIcon className="w-8 h-8 text-slate-600" />
            <p className="text-sm font-medium">Sin datos históricos para este rango</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {activeTab === 'combined' ? (
              // 1. GRÁFICA COMBINADA: Doble Eje Y (OD mg/L y Velocidad %)
              <AreaChart data={history} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorDO" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="colorSpeed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.6} />
                <XAxis dataKey="timeLabel" stroke="#64748b" tick={{ fontSize: 11 }} />
                
                {/* Eje Y Izquierdo para Oxígeno Disuelto */}
                <YAxis
                  yAxisId="left"
                  stroke="#06b6d4"
                  domain={[0, 12]}
                  tick={{ fontSize: 11 }}
                  unit=" mg/L"
                />
                {/* Eje Y Derecho para Velocidad de Motor */}
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#3b82f6"
                  domain={[0, 100]}
                  tick={{ fontSize: 11 }}
                  unit="%"
                />
                
                <Tooltip content={<CustomTooltip />} />
                
                {/* Línea de referencia: OD Mínimo Seguro */}
                <ReferenceLine
                  yAxisId="left"
                  y={thresholds.critical}
                  stroke="#f43f5e"
                  strokeDasharray="4 4"
                  label={{
                    value: `OD Crítico (${thresholds.critical} mg/L)`,
                    fill: '#f43f5e',
                    fontSize: 10,
                    position: 'insideBottomRight'
                  }}
                />

                {showSpeed && (
                  <Area
                    yAxisId="right"
                    type="monotone"
                    dataKey="motor_speed_percent"
                    name="Velocidad Aireador"
                    unit="%"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorSpeed)"
                  />
                )}

                {showDO && (
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="dissolved_oxygen_mg_l"
                    name="Oxígeno Disuelto"
                    unit="mg/L"
                    stroke="#06b6d4"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#colorDO)"
                  />
                )}

                {showTemp && (
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="water_temperature_c"
                    name="Temp. Agua"
                    unit="°C"
                    stroke="#14b8a6"
                    strokeWidth={1.5}
                    dot={false}
                  />
                )}
              </AreaChart>
            ) : activeTab === 'do' ? (
              // 2. GRÁFICA DE OXÍGENO DISUELTO CON LÍNEAS DE UMBRAL
              <AreaChart data={history} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorDOOnly" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.6} />
                <XAxis dataKey="timeLabel" stroke="#64748b" tick={{ fontSize: 11 }} />
                <YAxis stroke="#06b6d4" domain={[2, 12]} tick={{ fontSize: 11 }} unit=" mg/L" />
                <Tooltip content={<CustomTooltip />} />
                
                {/* Umbral Crítico */}
                <ReferenceLine
                  y={thresholds.critical}
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  label={{ value: `Mínimo Seguro: ${thresholds.critical} mg/L`, fill: '#f43f5e', fontSize: 11 }}
                />
                {/* Umbral Advertencia */}
                <ReferenceLine
                  y={thresholds.warning}
                  stroke="#f59e0b"
                  strokeDasharray="3 3"
                  label={{ value: `Advertencia: ${thresholds.warning} mg/L`, fill: '#f59e0b', fontSize: 11 }}
                />

                <Area
                  type="monotone"
                  dataKey="dissolved_oxygen_mg_l"
                  name="Oxígeno Disuelto"
                  unit="mg/L"
                  stroke="#06b6d4"
                  strokeWidth={3}
                  fillOpacity={1}
                  fill="url(#colorDOOnly)"
                />
              </AreaChart>
            ) : (
              // 3. GRÁFICA DE VELOCIDAD DE AIREADOR E INTERVALOS ACTIVOS
              <AreaChart data={history} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorMotorOnly" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.6} />
                <XAxis dataKey="timeLabel" stroke="#64748b" tick={{ fontSize: 11 }} />
                <YAxis stroke="#3b82f6" domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                <Tooltip content={<CustomTooltip />} />

                <Area
                  type="stepAfter"
                  dataKey="motor_speed_percent"
                  name="Velocidad Thruster T200"
                  unit="%"
                  stroke="#3b82f6"
                  strokeWidth={2.5}
                  fillOpacity={1}
                  fill="url(#colorMotorOnly)"
                />
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
