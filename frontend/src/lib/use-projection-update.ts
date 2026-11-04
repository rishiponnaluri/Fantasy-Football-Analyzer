'use client';
import { useEffect, useRef } from 'react';
import { PROJECTION_CHANGED } from './api';

/** Update data in place without resetting filters, selection, or navigation. */
export function useProjectionUpdate(refresh: () => void) {
  const current = useRef(refresh);
  current.current = refresh;
  useEffect(() => {
    const changed = () => current.current();
    window.addEventListener(PROJECTION_CHANGED, changed);
    return () => window.removeEventListener(PROJECTION_CHANGED, changed);
  }, []);
}
