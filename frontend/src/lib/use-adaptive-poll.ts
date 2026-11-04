'use client';
import {useEffect,useRef} from 'react';
import {startAdaptivePolling} from './adaptive-polling.mjs';
export function useAdaptivePoll({load,onError,enabled=true,week,currentWeek,live=false,upcoming=false}:{load:(signal:AbortSignal)=>Promise<unknown>;onError?:(error:unknown)=>void;enabled?:boolean;week?:number|null;currentWeek?:number|null;live?:boolean;upcoming?:boolean}){
  const latest=useRef({load,onError,enabled,week,currentWeek,live,upcoming});
  latest.current={load,onError,enabled,week,currentWeek,live,upcoming};
  useEffect(()=>startAdaptivePolling({load:(signal:AbortSignal)=>latest.current.load(signal),onError:(error:unknown)=>latest.current.onError?.(error),state:()=>latest.current,document,window}),[enabled,week,currentWeek,live,upcoming]);
}
