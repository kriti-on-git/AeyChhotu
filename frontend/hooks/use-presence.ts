"use client";

import { useEffect } from "react";
import { getDeviceId } from "@/lib/api/session";
import { heartbeat, releasePresence } from "@/lib/api/store";

const HEARTBEAT_MS = 15_000;

/* Announces this device to the DEMO store so a screen can show how many
   phones are live on a table. Live deployments use Supabase Presence instead
   (see trackTablePresence / ActiveDinersBadge) — pass `enabled: false` there
   so an offline heartbeat is not written for a board that never reads it. */
export function usePresence(tableToken: string | null = null, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const deviceId = getDeviceId();

    heartbeat(deviceId, tableToken);
    const timer = window.setInterval(() => heartbeat(deviceId, tableToken), HEARTBEAT_MS);

    const handleHide = () => releasePresence(deviceId);
    window.addEventListener("pagehide", handleHide);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", handleHide);
    };
  }, [tableToken, enabled]);
}
