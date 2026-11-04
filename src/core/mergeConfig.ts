import type { CorriereRequestConfig } from '../types';

const unsafeKeys = new Set<string>(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Copy configuration containers, preserving opaque objects such as transports. */
function cloneContainer(value: any, seen = new WeakMap<object, any>()): any {
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const copy: Record<string, any> = Array.isArray(value) ? new Array(value.length) : {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
      copy[key] = cloneContainer((value as Record<string, any>)[key], seen);
    }
  }
  return copy;
}

function deepMerge(...sources: any[]): Record<string, any> {
  const result: Record<string, any> = {};
  const seen = new WeakMap<object, any>();
  const merge = (target: Record<string, any>, source: Record<string, any>): void => {
    seen.set(source, target);
    for (const key of Object.keys(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const value = source[key];
      if (value === undefined) continue;
      if (isPlainObject(value)) {
        if (seen.has(value)) target[key] = seen.get(value);
        else {
          const child = Object.hasOwn(target, key) && isPlainObject(target[key]) ? target[key] : {};
          target[key] = child;
          merge(child, value);
        }
      } else {
        target[key] = cloneContainer(value, seen);
      }
    }
  };
  for (const source of sources) {
    if (isPlainObject(source)) merge(result, source);
  }
  return result;
}

const headerGroups = new Set([
  'common',
  'get',
  'head',
  'post',
  'put',
  'patch',
  'delete',
  'options',
]);

/** Undefined header values are tombstones, retained until headers are flattened. */
function mergeHeaders(...sources: any[]): Record<string, any> {
  const result: Record<string, any> = {};
  const names = new Map<string, string>();
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of Object.keys(source)) {
      if (unsafeKeys.has(key)) continue;
      const lower = key.toLowerCase();
      const previous = names.get(lower);
      const value = source[key];
      const merged =
        headerGroups.has(key) && isPlainObject(value)
          ? mergeHeaders(previous ? result[previous] : undefined, value)
          : cloneContainer(value);
      if (previous !== undefined) delete result[previous];
      result[key] = merged;
      names.set(lower, key);
    }
  }
  return result;
}

const requestOnlyKeys = new Set<string>(['url', 'data', 'signal']);
const containerKeys = new Set<string>(['params', 'hooks', 'auth', 'formSerializer']);

function copyValue(key: string, value: any): any {
  if (key === 'headers') return mergeHeaders(value);
  if (containerKeys.has(key)) return cloneContainer(value);
  return Array.isArray(value) ? [...value] : value;
}

export default function mergeConfig(
  config1: CorriereRequestConfig = {},
  config2: CorriereRequestConfig = {},
): CorriereRequestConfig {
  const merged: any = {};
  for (const key of Object.keys(config1)) {
    if (requestOnlyKeys.has(key) || unsafeKeys.has(key)) continue;
    merged[key] = copyValue(key, config1[key as keyof CorriereRequestConfig]);
  }
  for (const key of Object.keys(config2)) {
    if (unsafeKeys.has(key)) continue;
    const value = config2[key as keyof CorriereRequestConfig];
    if (value === undefined) continue;
    const inherited = config1[key as keyof CorriereRequestConfig];
    if (key === 'headers') merged[key] = mergeHeaders(inherited, value);
    else if ((key === 'params' || key === 'hooks') && isPlainObject(value)) {
      merged[key] = deepMerge(inherited, value);
    } else merged[key] = copyValue(key, value);
  }
  return merged;
}

export { deepMerge };
