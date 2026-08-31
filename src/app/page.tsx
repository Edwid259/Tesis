'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/Header';
import { MetricCards } from '@/components/MetricCards';
import { MotorControlPanel } from '@/components/MotorControlPanel';
import { ChartsSection } from '@/components/ChartsSection';
import { EventsTable } from '@/components/EventsTable';
import { AlertsPanel } from '@/components/AlertsPanel';
import {
  DashboardSummaryResponse,
  HistoryDataPoint,
  MotorEvent,
  Alert
} from '@/types';
import {
  demoThresholds,
  demoSensorDevice,
  demoMotorDevice,
  getDemoLatestSensorReading,
  getDemoLatestMotorTelemetry,
  generateDemoHistory,
  demoEvents,
  demoAlerts
} from '@/lib/demoData';
import { ShieldCheck, Info, Sparkles, Sliders } from 'lucide-react';

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummaryResponse>({
    sensorDevice: demoSensorDevice,
    motorDevice: demoMotorDevice,
    latestSensorReading: getDemoLatestSensorReading(),
    latestMotorTelemetry: getDemoLatestMotorTelemetry(),
    thresholds: demoThresholds,
    activeAlertsCount: 1,
    systemHealth: 'optimal',
    isLive: false
  });

  const [history, setHistory] = useState<HistoryDataPoint[]>([]);
  const [events, setEvents] = useState<MotorEvent[]>(demoEvents);
  const [alerts, setAlerts] = useState<Alert[]>(demoAlerts);
  const [selectedRange, setSelectedRange] = useState<string>('24h');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string>('Recién cargado');

  // Función principal para cargar datos de la dashboard
  const fetchDashboardData = useCallback(async (isBackground: boolean = false) => {
    if (!isBackground) setIsLoading(true);

    try {
      // 1. Obtener Resumen General
      const summaryRes = await fetch('/api/dashboard/summary', { cache: 'no-store' });
      if (summaryRes.ok) {
        const summaryData: DashboardSummaryResponse = await summaryRes.json();
        setSummary(summaryData);
      }

      // 2. Obtener Historial de Gráficas
      const historyRes = await fetch(`/api/dashboard/history?range=${selectedRange}`, { cache: 'no-store' });
      if (historyRes.ok) {
        const historyData = await historyRes.json();
        setHistory(historyData.data || []);
      }

      // 3. Obtener Eventos
      const eventsRes = await fetch('/api/events', { cache: 'no-store' });
      if (eventsRes.ok) {
        const eventsData = await eventsRes.json();
        setEvents(eventsData.events || []);
      }

      // 4. Obtener Alertas
      const alertsRes = await fetch('/api/alerts', { cache: 'no-store' });
      if (alertsRes.ok) {
        const alertsData = await alertsRes.json();
        setAlerts(alertsData.alerts || []);
      }

      const now = new Date();
      setLastUpdated(`Actualizado: ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    } catch (err) {
      console.error('Error refrescando datos de dashboard:', err);
      // Si ocurre un error de red local, mantener datos demo
      if (history.length === 0) {
        setHistory(generateDemoHistory(24));
      }
    } finally {
      if (!isBackground) setIsLoading(false);
    }
  }, [selectedRange, history.length]);

  // Carga inicial y actualización automática cada 15 segundos
  useEffect(() => {
    fetchDashboardData(false);

    const interval = setInterval(() => {
      fetchDashboardData(true);
    }, 15000); // 15s refresh interval

    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  // Acción para resolver o reconocer alertas
  const handleAcknowledgeAlert = async (alertId: number, newStatus: 'reconocida' | 'resuelta') => {
    try {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_id: alertId, action: newStatus })
      });
      // Actualizar estado local inmediatamente
      setAlerts(prev =>
        prev.map(a => (a.id === alertId ? { ...a, status: newStatus } : a))
      );
    } catch (err) {
      console.error('Error actualizando alerta:', err);
    }
  };

  return (
    <div className="min-h-screen bg-[#080c14] text-slate-100 flex flex-col">
      {/* Header Superior */}
      <Header
        sensorDevice={summary.sensorDevice}
        motorDevice={summary.motorDevice}
        isLive={summary.isLive}
        isLoading={isLoading}
        onRefresh={() => fetchDashboardData(false)}
        lastUpdatedText={lastUpdated}
      />

      {/* Contenedor Principal */}
      <main className="flex-1 p-4 lg:p-8 max-w-[1680px] w-full mx-auto flex flex-col gap-6">
        
        {/* Banner de Bienvenida y Estado del Estanque */}
        <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 border border-cyan-900/30 p-4 rounded-2xl">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-950 text-cyan-400 border border-cyan-800/80 shadow-md">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                Monitoreo y Control en Tiempo Real - Estanque Principal
              </h2>
              <p className="text-xs text-slate-400">
                Sistema IoT con sensor óptico de Oxígeno Disuelto y propulsor Blue Robotics T200 (ESC PWM)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">Intervalo de telemetría: <strong className="text-cyan-400 font-semibold">15s</strong></span>
            <span className="text-slate-600">|</span>
            <span className="text-slate-400">Ubicación: <strong className="text-slate-200">Zona de Cultivo Norte</strong></span>
          </div>
        </div>

        {/* 1. Tarjetas de Resumen KPI y Semáforo de Oxígeno Disuelto */}
        <section>
          <MetricCards
            reading={summary.latestSensorReading}
            motor={summary.latestMotorTelemetry}
            thresholds={summary.thresholds}
            lastUpdated={lastUpdated}
          />
        </section>

        {/* 2. Panel de Control del Aireador Thruster T200 */}
        <section>
          <MotorControlPanel
            motorDevice={summary.motorDevice}
            currentTelemetry={summary.latestMotorTelemetry}
            onCommandSent={() => fetchDashboardData(true)}
          />
        </section>

        {/* 3. Gráficas Principales (OD, Velocidad y Combinada con doble eje) */}
        <section>
          <ChartsSection
            history={history}
            thresholds={summary.thresholds}
            selectedRange={selectedRange}
            onRangeChange={(range) => setSelectedRange(range)}
            isLoading={isLoading}
          />
        </section>

        {/* 4. Tablas de Eventos y Panel de Alertas */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <EventsTable events={events} />
          <AlertsPanel alerts={alerts} onAcknowledgeAlert={handleAcknowledgeAlert} />
        </section>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-800/80 py-4 px-6 text-center text-xs text-slate-500 flex flex-wrap items-center justify-between gap-4">
        <span>AquaControl IoT © 2026 - Sistema de Telemetría y Oxigenación de Acuicultura</span>
        <div className="flex items-center gap-4 text-[11px]">
          <span>Next.js 14 App Router</span>
          <span>•</span>
          <span>Supabase PostgreSQL</span>
          <span>•</span>
          <span>Vercel Edge Ready</span>
        </div>
      </footer>
    </div>
  );
}
