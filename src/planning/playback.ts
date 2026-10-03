import { type AnimKey, type KeyframeDoc } from "../project/viewerPack";
import { DEFAULT_SWING, parseIsoDate, poseOf, type PlanPoint, type SitePlan } from "./sitePlan";

export type { AnimKey };

export interface MotionPose {
  id: string;
  rx: number;
  ry: number;
  rz: number;
  mastHeight?: number;
  jibLength?: number;
  hook?: number;
  slew?: number;
  depth?: number;
  grow?: number;
  at?: PlanPoint;
}

export interface PlaybackClock {
  playing: boolean;
  seconds: number;
  preview: boolean;
}

export function sampleKeys(keys: AnimKey[], t: number): AnimKey | null {
  if (!keys.length) return null;
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const u = Math.min(1, Math.max(0, t));
  const first = sorted[0]!;
  if (u <= first.t) return { ...first, t: u };
  const last = sorted[sorted.length - 1]!;
  if (u >= last.t) return { ...last, t: u };
  let index = 1;
  while (index < sorted.length && sorted[index]!.t < u) index += 1;
  const a = sorted[index - 1]!;
  const b = sorted[index]!;
  const span = b.t - a.t || 1;
  const f = (u - a.t) / span;
  const lerp = (av?: number, bv?: number) => {
    if (av == null && bv == null) return undefined;
    if (av == null) return bv;
    if (bv == null) return av;
    return av + (bv - av) * f;
  };
  return {
    t: u,
    rx: lerp(a.rx, b.rx),
    ry: lerp(a.ry, b.ry),
    rz: lerp(a.rz, b.rz),
    mastHeight: lerp(a.mastHeight, b.mastHeight),
    jibLength: lerp(a.jibLength, b.jibLength),
    hook: lerp(a.hook, b.hook),
    pathT: lerp(a.pathT, b.pathT),
  };
}

export function pointAlong(points: PlanPoint[], t: number): { point: PlanPoint; yaw: number } {
  if (!points.length) return { point: { x: 0, y: 0, z: 0 }, yaw: 0 };
  if (points.length === 1) return { point: { ...points[0]! }, yaw: 0 };
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    lengths.push(len);
    total += len;
  }
  let remain = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    const a = points[i]!;
    const b = points[i + 1]!;
    if (remain <= len || i === lengths.length - 1) {
      const f = len > 1e-6 ? Math.min(1, remain / len) : 0;
      return {
        point: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f },
        yaw: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }
    remain -= len;
  }
  const last = points[points.length - 1]!;
  return { point: { ...last }, yaw: 0 };
}

export function fractionBetween(date: Date, start: Date, end: Date): number {
  const a = start.getTime();
  const b = end.getTime();
  if (!(b > a)) return 0;
  return Math.min(1, Math.max(0, (date.getTime() - a) / (b - a)));
}

export function motionsAt(
  plan: SitePlan,
  doc: KeyframeDoc,
  date: Date,
  schedule: { start: Date; end: Date } | null,
  clock?: PlaybackClock,
): MotionPose[] {
  const poses: MotionPose[] = [];
  const trackOf = (id: string) => doc.tracks.find((track) => track.targetId === id);
  const atTime = (lineId?: string) => {
    const line = lineId ? plan.lines.find((item) => item.id === lineId) : undefined;
    if (line) return fractionBetween(date, parseIsoDate(line.start), parseIsoDate(line.end));
    if (schedule) return fractionBetween(date, schedule.start, schedule.end);
    return 0;
  };
  for (const crane of plan.cranes) {
    const rest = poseOf(crane);
    const keys = trackOf(crane.id)?.keys ?? [];
    const sample = sampleKeys(keys, atTime(crane.lineId));
    const keyed = (field: "rz" | "hook") => keys.some((key) => key[field] != null);
    let hook = sample?.hook ?? crane.hook ?? 4;
    let slew = 0;
    if (clock?.playing) {
      if (!keyed("rz")) {
        const sweep = ((crane.swing ?? DEFAULT_SWING) * Math.PI) / 180;
        slew = Math.sin(clock.seconds * 0.45) * Math.min(Math.PI, sweep * 0.5);
      }
      if (!keyed("hook")) {
        const restHook = crane.hook ?? 4;
        hook = Math.max(0.8, restHook * (0.42 + 0.58 * Math.abs(Math.sin(clock.seconds * 0.9))));
      }
    }
    poses.push({
      id: crane.id,
      rx: sample?.rx ?? rest.rx,
      ry: sample?.ry ?? rest.ry,
      rz: sample?.rz ?? rest.rz,
      mastHeight: sample?.mastHeight ?? crane.mastHeight,
      jibLength: sample?.jibLength ?? crane.jibLength,
      hook,
      slew,
    });
  }
  for (const truck of plan.trucks) {
    const rest = poseOf(truck);
    const track = trackOf(truck.id);
    const sample = sampleKeys(track?.keys ?? [], atTime(truck.lineId));
    const pose: MotionPose = {
      id: truck.id,
      rx: sample?.rx ?? rest.rx,
      ry: sample?.ry ?? rest.ry,
      rz: sample?.rz ?? rest.rz,
    };
    const path = truck.pathId ? plan.paths.find((item) => item.id === truck.pathId) : undefined;
    if (path && path.points.length > 1) {
      let pathT = sample?.pathT;
      if (pathT == null && clock?.playing && (truck.duration ?? 0) > 0) pathT = Math.min(1, clock.seconds / truck.duration!);
      else if (pathT == null && clock?.preview) pathT = 0;
      else if (pathT == null) pathT = atTime(truck.lineId);
      const along = pointAlong(path.points, pathT);
      pose.at = along.point;
      pose.rz = along.yaw;
    }
    poses.push(pose);
  }
  for (const drill of plan.drills) {
    const rest = poseOf(drill);
    const fraction = clock?.preview ? 1 : Math.max(0.05, atTime(drill.lineId));
    poses.push({
      id: drill.id,
      rx: rest.rx,
      ry: rest.ry,
      rz: rest.rz,
      depth: drill.depth * fraction,
    });
  }
  for (const mass of plan.masses) {
    const rest = poseOf(mass);
    const fraction = clock?.preview || !mass.grow ? 1 : atTime(mass.lineId);
    poses.push({ id: mass.id, rx: rest.rx, ry: rest.ry, rz: rest.rz, grow: fraction });
  }
  for (const fence of plan.fences) {
    const rest = poseOf(fence);
    poses.push({ id: fence.id, rx: rest.rx, ry: rest.ry, rz: rest.rz });
  }
  return poses;
}
