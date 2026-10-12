import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

import fs from 'fs';
import path from 'path';

function getRootEnv(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const rootEnv = path.join(process.cwd(), '..', '.env');
    if (fs.existsSync(rootEnv)) {
      const content = fs.readFileSync(rootEnv, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
    }
  } catch {}
  return map;
}

const rootEnv = getRootEnv();

const rawSupabaseUrl =
  (process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_URL.includes('placeholder')
    ? process.env.NEXT_PUBLIC_SUPABASE_URL
    : process.env.SUPABASE_URL || rootEnv.SUPABASE_URL) || 'https://placeholder.supabase.co';

const supabaseUrl = rawSupabaseUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');

const supabaseAnonKey = (
  (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.includes('placeholder')
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    : process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SECRET_KEY || rootEnv.SUPABASE_PUBLISHABLE_KEY || rootEnv.SUPABASE_SECRET_KEY) || 'placeholder-anon'
).trim();

const supabaseServiceRoleKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY.includes('placeholder')
    ? process.env.SUPABASE_SERVICE_ROLE_KEY
    : process.env.SUPABASE_SECRET_KEY || rootEnv.SUPABASE_SECRET_KEY
)?.trim();

// Cliente público para el frontend y consultas autorizadas con RLS
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Cliente administrativo (solo servidor) para verificar API keys y operaciones críticas
export const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey || supabaseAnonKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

/**
 * Genera el hash SHA-256 de una API key para almacenamiento y comparación segura
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key.trim()).digest('hex');
}

/**
 * Valida si las credenciales de Supabase están configuradas realmente o son de placeholder
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    supabaseUrl &&
    !supabaseUrl.includes('placeholder') &&
    supabaseAnonKey &&
    !supabaseAnonKey.includes('placeholder')
  );
}
