"use client";

import { useEffect } from "react";
import { getDeviceId } from "@/lib/api/session";
import { heartbeat, releasePresence } from "@/lib/api/store";

const HEARTBEAT_MS = 15_000;

/* Announces this device to the shared state so every screen can show how
   many phones are live on a table. */
export function usePresence(tableToken: string | null = null) {
  useEffect(() => {
    const deviceId = getDeviceId();

    heartbeat(deviceId, tableToken);
    const timer = window.setInterval(() => heartbeat(deviceId, tableToken), HEARTBEAT_MS);

    const handleHide = () => releasePresence(deviceId);
    window.addEventListener("pagehide", handleHide);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", handleHide);
    };
  }, [tableToken]);
}
