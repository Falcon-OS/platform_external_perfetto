// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import '../tracks/all_controller';

import * as uuidv4 from 'uuid/v4';

import {assertExists, assertTrue} from '../base/logging';
import {
  Actions,
  AddTrackArgs,
  DeferredAction,
} from '../common/actions';
import {Engine} from '../common/engine';
import {NUM, NUM_NULL, rawQueryToRows, STR_NULL} from '../common/protos';
import {SCROLLING_TRACK_GROUP} from '../common/state';
import {toNs, toNsCeil, toNsFloor} from '../common/time';
import {TimeSpan} from '../common/time';
import {
  createWasmEngine,
  destroyWasmEngine,
  WasmEngineProxy
} from '../common/wasm_engine_proxy';
import {QuantizedLoad, ThreadDesc} from '../frontend/globals';
import {ANDROID_LOGS_TRACK_KIND} from '../tracks/android_log/common';
import {SLICE_TRACK_KIND} from '../tracks/chrome_slices/common';
import {CPU_FREQ_TRACK_KIND} from '../tracks/cpu_freq/common';
import {CPU_SLICE_TRACK_KIND} from '../tracks/cpu_slices/common';
import {GPU_FREQ_TRACK_KIND} from '../tracks/gpu_freq/common';
import {HEAP_PROFILE_TRACK_KIND} from '../tracks/heap_profile/common';
import {
  HEAP_PROFILE_FLAMEGRAPH_TRACK_KIND
} from '../tracks/heap_profile_flamegraph/common';
import {
  PROCESS_SCHEDULING_TRACK_KIND
} from '../tracks/process_scheduling/common';
import {PROCESS_SUMMARY_TRACK} from '../tracks/process_summary/common';
import {THREAD_STATE_TRACK_KIND} from '../tracks/thread_state/common';

import {Child, Children, Controller} from './controller';
import {globals} from './globals';
import {LoadingManager} from './loading_manager';
import {LogsController} from './logs_controller';
import {QueryController, QueryControllerArgs} from './query_controller';
import {SearchController} from './search_controller';
import {
  SelectionController,
  SelectionControllerArgs
} from './selection_controller';
import {
  TraceBufferStream,
  TraceFileStream,
  TraceHttpStream,
  TraceStream
} from './trace_stream';
import {TrackControllerArgs, trackControllerRegistry} from './track_controller';

type States = 'init'|'loading_trace'|'ready';

interface ThreadSliceTrack {
  maxDepth: number;
  trackId: number;
}

// TraceController handles handshakes with the frontend for everything that
// concerns a single trace. It owns the WASM trace processor engine, handles
// tracks data and SQL queries. There is one TraceController instance for each
// trace opened in the UI (for now only one trace is supported).
export class TraceController extends Controller<States> {
  private readonly engineId: string;
  private engine?: Engine;

  constructor(engineId: string) {
    super('init');
    this.engineId = engineId;
  }

  onDestroy() {
    if (this.engine instanceof WasmEngineProxy) {
      destroyWasmEngine(this.engine.id);
    }
  }

  run() {
    const engineCfg = assertExists(globals.state.engines[this.engineId]);
    switch (this.state) {
      case 'init':
        globals.dispatch(Actions.setEngineReady({
          engineId: this.engineId,
          ready: false,
        }));
        this.loadTrace()
            .then(() => {
              globals.dispatch(Actions.setEngineReady({
                engineId: this.engineId,
                ready: true,
              }));
            })
            .catch(err => {
              this.updateStatus(`${err}`);
              this.setState('init');
              console.error(err);
              return;
            });
        this.updateStatus('Opening trace');
        this.setState('loading_trace');
        break;

      case 'loading_trace':
        // Stay in this state until loadTrace() returns and marks the engine as
        // ready.
        if (this.engine === undefined || !engineCfg.ready) return;
        this.setState('ready');
        break;

      case 'ready':
        // At this point we are ready to serve queries and handle tracks.
        const engine = assertExists(this.engine);
        assertTrue(engineCfg.ready);
        const childControllers: Children = [];

        // Create a TrackController for each track.
        for (const trackId of Object.keys(globals.state.tracks)) {
          const trackCfg = globals.state.tracks[trackId];
          if (trackCfg.engineId !== this.engineId) continue;
          if (!trackControllerRegistry.has(trackCfg.kind)) continue;
          const trackCtlFactory = trackControllerRegistry.get(trackCfg.kind);
          const trackArgs: TrackControllerArgs = {trackId, engine};
          childControllers.push(Child(trackId, trackCtlFactory, trackArgs));
        }

        // Create a QueryController for each query.
        for (const queryId of Object.keys(globals.state.queries)) {
          const queryArgs: QueryControllerArgs = {queryId, engine};
          childControllers.push(Child(queryId, QueryController, queryArgs));
        }

        const selectionArgs: SelectionControllerArgs = {engine};
        childControllers.push(
          Child('selection', SelectionController, selectionArgs));

        childControllers.push(Child('search', SearchController, {
          engine,
          app: globals,
        }));

        childControllers.push(Child('logs', LogsController, {
          engine,
          app: globals,
        }));

        return childControllers;

      default:
        throw new Error(`unknown state ${this.state}`);
    }
    return;
  }

  private async loadTrace() {
    this.updateStatus('Creating trace processor');
    const engineCfg = assertExists(globals.state.engines[this.engineId]);

    console.log('Opening trace using built-in WASM engine');
    this.engine = new WasmEngineProxy(
        this.engineId,
        createWasmEngine(this.engineId),
        LoadingManager.getInstance);
    let traceStream: TraceStream;
    if (engineCfg.source instanceof File) {
      traceStream = new TraceFileStream(engineCfg.source);
    } else if (engineCfg.source instanceof ArrayBuffer) {
      traceStream = new TraceBufferStream(engineCfg.source);
    } else {
      traceStream = new TraceHttpStream(engineCfg.source);
    }

    const tStart = performance.now();
    for (;;) {
      const res = await traceStream.readChunk();
      await this.engine.parse(res.data);
      const elapsed = (performance.now() - tStart) / 1000;
      let status = 'Loading trace ';
      if (res.bytesTotal > 0) {
        const progress = Math.round(res.bytesRead / res.bytesTotal * 100);
        status += `${progress}%`;
      } else {
        status += `${Math.round(res.bytesRead / 1e6)} MB`;
      }
      status += ` - ${Math.ceil(res.bytesRead / elapsed / 1e6)} MB/s`;
      this.updateStatus(status);
      if (res.eof) break;
    }
    await this.engine.notifyEof();

    const traceTime = await this.engine.getTraceTimeBounds();
    const traceTimeState = {
      startSec: traceTime.start,
      endSec: traceTime.end,
    };
    const actions: DeferredAction[] = [
      Actions.setTraceTime(traceTimeState),
      Actions.navigate({route: '/viewer'}),
    ];

    // We don't know the resolution at this point. However this will be
    // replaced in 50ms so a guess is fine.
    const resolution = (traceTime.end - traceTime.start) / 1000;
    actions.push(Actions.setVisibleTraceTime(
        {...traceTimeState, lastUpdate: Date.now() / 1000, resolution}));

    globals.dispatchMultiple(actions);

    {
      // When we reload from a permalink don't create extra tracks:
      const {pinnedTracks, tracks} = globals.state;
      if (!pinnedTracks.length && !Object.keys(tracks).length) {
        await this.listTracks();
      }
    }

    await this.listThreads();
    await this.loadTimelineOverview(traceTime);
  }

  private async listTracks() {
    this.updateStatus('Loading tracks');

    const engine = assertExists<Engine>(this.engine);
    const numGpus = await engine.getNumberOfGpus();
    const tracksToAdd: AddTrackArgs[] = [];

    // TODO(hjd): Renable Vsync tracks when fixed.
    //// TODO(hjd): Move this code out of TraceController.
    // for (const counterName of ['VSYNC-sf', 'VSYNC-app']) {
    //  const hasVsync =
    //      !!(await engine.query(
    //             `select ts from counters where name like "${
    //                                                         counterName
    //                                                       }" limit 1`))
    //            .numRecords;
    //  if (!hasVsync) continue;
    //  addToTrackActions.push(Actions.addTrack({
    //    engineId: this.engineId,
    //    kind: 'VsyncTrack',
    //    name: `${counterName}`,
    //    config: {
    //      counterName,
    //    }
    //  }));
    //}
    const maxCpuFreq = await engine.query(`
     select max(value)
     from counters
     where name = 'cpufreq';
    `);

    const cpus = await engine.getCpus();

    for (const cpu of cpus) {
      tracksToAdd.push({
        engineId: this.engineId,
        kind: CPU_SLICE_TRACK_KIND,
        name: `Cpu ${cpu}`,
        trackGroup: SCROLLING_TRACK_GROUP,
        config: {
          cpu,
        }
      });
    }

    for (const cpu of cpus) {
      // Only add a cpu freq track if we have
      // cpu freq data.
      // TODO(taylori): Find a way to display cpu idle
      // events even if there are no cpu freq events.
      const freqExists = await engine.query(`
        select value
        from counters
        where name = 'cpufreq' and ref = ${cpu}
        limit 1;
      `);
      if (freqExists.numRecords > 0) {
        tracksToAdd.push({
          engineId: this.engineId,
          kind: CPU_FREQ_TRACK_KIND,
          name: `Cpu ${cpu} Frequency`,
          trackGroup: SCROLLING_TRACK_GROUP,
          config: {
            cpu,
            maximumValue: +maxCpuFreq.columns[0].doubleValues![0],
          }
        });
      }
    }


    const upidToProcessTracks = new Map();
    const rawProcessTracks = await engine.query(`
      select id, upid, process_track.name, max(depth) as maxDepth
      from process_track
      inner join slice on slice.track_id = process_track.id
      group by track_id
    `);
    for (let i = 0; i < rawProcessTracks.numRecords; i++) {
      const trackId = rawProcessTracks.columns[0].longValues![i];
      const upid = rawProcessTracks.columns[1].longValues![i];
      const name = rawProcessTracks.columns[2].stringValues![i];
      const maxDepth = rawProcessTracks.columns[3].longValues![i];
      const track = {
        engineId: this.engineId,
        kind: 'AsyncSliceTrack',
        name,
        config: {
          trackId,
          maxDepth,
        },
      };

      const tracks = upidToProcessTracks.get(upid);
      if (tracks) {
        tracks.push(track);
      } else {
        upidToProcessTracks.set(upid, [track]);
      }
    }

    const heapProfiles = await engine.query(`
      select distinct(upid) from heap_profile_allocation`);

    const heapUpids: Set<number> = new Set();
    for (let i = 0; i < heapProfiles.numRecords; i++) {
      const upid = heapProfiles.columns[0].longValues![i];
      heapUpids.add(+upid);
    }

    const maxGpuFreq = await engine.query(`
     select max(value)
     from counters
     where name = 'gpufreq';
    `);

    for (let gpu = 0; gpu < numGpus; gpu++) {
      // Only add a gpu freq track if we have
      // gpu freq data.
      const freqExists = await engine.query(`
        select value
        from counters
        where name = 'gpufreq' and ref = ${gpu}
        limit 1;
      `);
      if (freqExists.numRecords > 0) {
        tracksToAdd.push({
          engineId: this.engineId,
          kind: GPU_FREQ_TRACK_KIND,
          name: `Gpu ${gpu} Frequency`,
          trackGroup: SCROLLING_TRACK_GROUP,
          config: {
            gpu,
            maximumValue: +maxGpuFreq.columns[0].doubleValues![0],
          }
        });
      }
    }


    const counters = await engine.query(`
      select name, ref, ref_type
      from counter_definitions
      where ref is not null
      group by name, ref, ref_type
      order by ref_type desc
    `);

    interface CounterMap {
      [index: number]: string[];
    }

    const counterUpids: CounterMap = new Array();
    const counterUtids: CounterMap = new Array();
    for (let i = 0; i < counters.numRecords; i++) {
      const name = counters.columns[0].stringValues![i];
      const ref = +counters.columns[1].longValues![i];
      const refType = counters.columns[2].stringValues![i];
      if (refType === 'upid') {
        const el = counterUpids[ref];
        el === undefined ? counterUpids[ref] = [name] :
                           counterUpids[ref].push(name);
      } else if (refType === 'utid') {
        const el = counterUtids[ref];
        el === undefined ? counterUtids[ref] = [name] :
                           counterUtids[ref].push(name);
      } else if (
          refType === '[NULL]' || (refType === 'gpu' && name !== 'gpufreq')) {
        // Add global or GPU counter tracks that are not bound to any pid/tid.
        tracksToAdd.push({
          engineId: this.engineId,
          kind: 'CounterTrack',
          name,
          trackGroup: SCROLLING_TRACK_GROUP,
          config: {
            name,
            ref: 0,
          }
        });
      }
    }

    // Local experiments shows getting maxDepth separately is ~2x faster than
    // joining with threads and processes.
    const maxDepthQuery = await engine.query(`
          select thread_track.utid, thread_track.id, max(depth) as maxDepth
          from slice
          inner join thread_track on slice.track_id = thread_track.id
          group by thread_track.id
        `);

    const utidToThreadTrack = new Map<number, ThreadSliceTrack>();
    for (let i = 0; i < maxDepthQuery.numRecords; i++) {
      const utid = maxDepthQuery.columns[0].longValues![i] as number;
      const trackId = maxDepthQuery.columns[1].longValues![i] as number;
      const maxDepth = maxDepthQuery.columns[2].longValues![i] as number;
      utidToThreadTrack.set(utid, {maxDepth, trackId});
    }

    // Return all threads
    // sorted by:
    //  total cpu time *for the whole parent process*
    //  upid
    //  utid
    const threadQuery = await engine.query(`
        select
          utid,
          tid,
          upid,
          pid,
          thread.name as threadName,
          process.name as processName,
          total_dur as totalDur
        from
          thread
          left join process using(upid)
          left join (select upid, sum(dur) as total_dur
              from sched join thread using(utid)
              group by upid
            ) using(upid) group by utid, upid
        order by total_dur desc, upid, utid`);

    const upidToUuid = new Map<number, string>();
    const utidToUuid = new Map<number, string>();
    const addTrackGroupActions: DeferredAction[] = [];

    for (const row of rawQueryToRows(threadQuery, {
           utid: NUM,
           upid: NUM_NULL,
           tid: NUM_NULL,
           pid: NUM_NULL,
           threadName: STR_NULL,
           processName: STR_NULL,
           totalDur: NUM_NULL,
         })) {
      const utid = row.utid;
      const tid = row.tid;
      const upid = row.upid;
      const pid = row.pid;
      const threadName = row.threadName;
      const processName = row.processName;
      const hasSchedEvents = !!row.totalDur;
      const threadSched =
          await engine.query(`select count(1) from sched where utid = ${utid}`);
      const threadHasSched = threadSched.columns[0].longValues![0] > 0;

      const threadTrack =
          utid === null ? undefined : utidToThreadTrack.get(utid);
      if (threadTrack === undefined &&
          (upid === null || counterUpids[upid] === undefined) &&
          counterUtids[utid] === undefined && !threadHasSched &&
          (upid === null || upid !== null && !heapUpids.has(upid))) {
        continue;
      }

      // Group by upid if present else by utid.
      let pUuid = upid === null ? utidToUuid.get(utid) : upidToUuid.get(upid);
      // These should only happen once for each track group.
      if (pUuid === undefined) {
        pUuid = uuidv4();
        const summaryTrackId = uuidv4();
        if (upid === null) {
          utidToUuid.set(utid, pUuid);
        } else {
          upidToUuid.set(upid, pUuid);
        }

        const pidForColor = pid || tid || upid || utid || 0;
        const kind = hasSchedEvents ? PROCESS_SCHEDULING_TRACK_KIND :
                                      PROCESS_SUMMARY_TRACK;

        tracksToAdd.push({
          id: summaryTrackId,
          engineId: this.engineId,
          kind,
          name: `${upid === null ? tid : pid} summary`,
          config: {pidForColor, upid, utid},
        });

        const name = upid === null ?
            `${threadName} ${tid}` :
            `${
                processName === null && heapUpids.has(upid) ?
                    'Heap Profile for' :
                    processName} ${pid}`;
        addTrackGroupActions.push(Actions.addTrackGroup({
          engineId: this.engineId,
          summaryTrackId,
          name,
          id: pUuid,
          collapsed: !(upid !== null && heapUpids.has(upid)),
        }));

        if (upid !== null) {
          const counterNames = counterUpids[upid];
          if (counterNames !== undefined) {
            counterNames.forEach(element => {
              tracksToAdd.push({
                engineId: this.engineId,
                kind: 'CounterTrack',
                name: element,
                trackGroup: pUuid,
                config: {
                  name: element,
                  ref: upid,
                }
              });
            });
          }

          if (heapUpids.has(upid)) {
            tracksToAdd.push({
              engineId: this.engineId,
              kind: HEAP_PROFILE_TRACK_KIND,
              name: `Heap Profile`,
              trackGroup: pUuid,
              config: {upid}
            });

            tracksToAdd.push({
              engineId: this.engineId,
              kind: HEAP_PROFILE_FLAMEGRAPH_TRACK_KIND,
              name: `Heap Profile Flamegraph`,
              trackGroup: pUuid,
              config: {upid}
            });
          }

          if (upidToProcessTracks.has(upid)) {
            for (const track of upidToProcessTracks.get(upid)) {
              tracksToAdd.push(Object.assign(track, {trackGroup: pUuid}));
            }
          }
        }
      }
      const counterThreadNames = counterUtids[utid];
      if (counterThreadNames !== undefined) {
        counterThreadNames.forEach(element => {
          tracksToAdd.push({
            engineId: this.engineId,
            kind: 'CounterTrack',
            name: element,
            trackGroup: pUuid,
            config: {
              name: element,
              ref: utid,
            }
          });
        });
      }
      if (threadHasSched) {
        tracksToAdd.push({
          engineId: this.engineId,
          kind: THREAD_STATE_TRACK_KIND,
          name: `${threadName} [${tid}]`,
          trackGroup: pUuid,
          config: {utid}
        });
      }

      if (threadTrack !== undefined) {
        tracksToAdd.push({
          engineId: this.engineId,
          kind: SLICE_TRACK_KIND,
          name: `${threadName} [${tid}]`,
          trackGroup: pUuid,
          config: {
            upid,
            utid,
            maxDepth: threadTrack.maxDepth,
            trackId: threadTrack.trackId
          },
        });
      }
    }

    const logCount = await engine.query(`select count(1) from android_logs`);
    if (logCount.columns[0].longValues![0] > 0) {
      tracksToAdd.push({
        engineId: this.engineId,
        kind: ANDROID_LOGS_TRACK_KIND,
        name: 'Android logs',
        trackGroup: SCROLLING_TRACK_GROUP,
        config: {}
      });
    }

    addTrackGroupActions.push(Actions.addTracks({tracks: tracksToAdd}));
    globals.dispatchMultiple(addTrackGroupActions);
  }

  private async listThreads() {
    this.updateStatus('Reading thread list');
    const sqlQuery = `select utid, tid, pid, thread.name,
        ifnull(
          case when length(process.name) > 0 then process.name else null end,
          thread.name)
        from (select * from thread order by upid) as thread
        left join (select * from process order by upid) as process
        using(upid)`;
    const threadRows = await assertExists(this.engine).query(sqlQuery);
    const threads: ThreadDesc[] = [];
    for (let i = 0; i < threadRows.numRecords; i++) {
      const utid = threadRows.columns[0].longValues![i] as number;
      const tid = threadRows.columns[1].longValues![i] as number;
      const pid = threadRows.columns[2].longValues![i] as number;
      const threadName = threadRows.columns[3].stringValues![i];
      const procName = threadRows.columns[4].stringValues![i];
      threads.push({utid, tid, threadName, pid, procName});
    }  // for (record ...)
    globals.publish('Threads', threads);
  }

  private async loadTimelineOverview(traceTime: TimeSpan) {
    const engine = assertExists<Engine>(this.engine);
    const numSteps = 100;
    const stepSec = traceTime.duration / numSteps;
    let hasSchedOverview = false;
    for (let step = 0; step < numSteps; step++) {
      this.updateStatus(
          'Loading overview ' +
          `${Math.round((step + 1) / numSteps * 1000) / 10}%`);
      const startSec = traceTime.start + step * stepSec;
      const startNs = toNsFloor(startSec);
      const endSec = startSec + stepSec;
      const endNs = toNsCeil(endSec);

      // Sched overview.
      const schedRows = await engine.query(
          `select sum(dur)/${stepSec}/1e9, cpu from sched ` +
          `where ts >= ${startNs} and ts < ${endNs} and utid != 0 ` +
          'group by cpu order by cpu');
      const schedData: {[key: string]: QuantizedLoad} = {};
      for (let i = 0; i < schedRows.numRecords; i++) {
        const load = schedRows.columns[0].doubleValues![i];
        const cpu = schedRows.columns[1].longValues![i] as number;
        schedData[cpu] = {startSec, endSec, load};
        hasSchedOverview = true;
      }  // for (record ...)
      globals.publish('OverviewData', schedData);
    }  // for (step ...)

    if (hasSchedOverview) {
      return;
    }

    // Slices overview.
    const traceStartNs = toNs(traceTime.start);
    const stepSecNs = toNs(stepSec);
    const sliceSummaryQuery = await engine.query(`select
           bucket,
           upid,
           sum(utid_sum) / cast(${stepSecNs} as float) as upid_sum
         from thread
         inner join (
           select
             cast((ts - ${traceStartNs})/${stepSecNs} as int) as bucket
             sum(dur) as utid_sum,
             utid
           from slice
           inner join thread_track on slice.track_id = thread_track.id
           group by bucket, utid
         ) using(utid)
         group by bucket, upid`);

    const slicesData: {[key: string]: QuantizedLoad[]} = {};
    for (let i = 0; i < sliceSummaryQuery.numRecords; i++) {
      const bucket = sliceSummaryQuery.columns[0].longValues![i] as number;
      const upid = sliceSummaryQuery.columns[1].longValues![i] as number;
      const load = sliceSummaryQuery.columns[2].doubleValues![i];

      const startSec = traceTime.start + stepSec * bucket;
      const endSec = startSec + stepSec;

      const upidStr = upid.toString();
      let loadArray = slicesData[upidStr];
      if (loadArray === undefined) {
        loadArray = slicesData[upidStr] = [];
      }
      loadArray.push({startSec, endSec, load});
    }
    globals.publish('OverviewData', slicesData);
  }

  private updateStatus(msg: string): void {
    globals.dispatch(Actions.updateStatus({
      msg,
      timestamp: Date.now() / 1000,
    }));
  }
}
