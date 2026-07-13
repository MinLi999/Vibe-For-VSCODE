import type { Env, RegionPreference } from '../types';

export interface DashscopeRegion {
  apac: boolean;
  baseUrl: string;
  /** DashScope API keys are region-locked (a Singapore key 403s against the US endpoint and
   *  vice versa) — each region carries its own secret. */
  apiKey: string | undefined;
}

/**
 * Shared region resolution for all DashScope calls (ASR + rewrite). A manual user preference
 * ('apac'/'us') wins outright; otherwise Asia/Oceania traffic goes to the Singapore region and
 * everything else to the US region, so non-APAC users don't detour through Singapore.
 * `continent` comes from Cloudflare's `request.cf.continent` (AS/OC/EU/NA/SA/AF/AN).
 */
export function resolveDashscopeRegion(env: Env, continent: string | undefined, preference?: RegionPreference): DashscopeRegion {
  const apac = preference === 'apac' ? true : preference === 'us' ? false : continent === 'AS' || continent === 'OC';
  const baseUrl = apac
    ? (env.DASHSCOPE_BASE_URL_APAC ?? 'https://dashscope-intl.aliyuncs.com')
    : (env.DASHSCOPE_BASE_URL_US ?? 'https://dashscope-us.aliyuncs.com');
  return {
    apac,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: apac ? env.DASHSCOPE_API_KEY_APAC : env.DASHSCOPE_API_KEY_US,
  };
}
