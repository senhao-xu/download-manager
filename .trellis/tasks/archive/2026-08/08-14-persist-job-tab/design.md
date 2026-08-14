# Design - Persist active job across tab switches

## Approach

Lift the active job + its SSE subscription out of the per-tab components into a
single shared hook instantiated **once at the App level**. Tabs consume it via
props (or context), not their own `useState`/`useJobSubscription`.

```
App
 ├─ useActiveJob()  ← owns: job state, EventSource, ownerTab, start/reset
 │   (one instance, lives for App's lifetime - survives tab unmount)
 ├─ <YouTubeTab activeJob={...} startJob={...} />
 ├─ <HttpTab     activeJob={...} startJob={...} />
 └─ <BtTab       activeJob={...} startJob={...} />

Each tab renders <JobView> only when activeJob exists AND activeJob.ownerTab === thisTab.
```

## Why lift to App (not context, not per-tab persistence)

- **Props from App is the smallest change** that fixes the root cause. The
  `useActiveJob` hook's `useState`/`useRef` live in `App`'s render scope, so they
  are NOT destroyed when a tab component unmounts. The `EventSource` (in a ref)
  survives too.
- A React Context would also work and is marginally cleaner if many components
  need it, but only the three tabs + App touch the job. Props avoid a new
  Provider and keep the data flow explicit. Chose props.
- Per-tab "keep mounted" (render all tabs, hide with CSS) was rejected: it keeps
  three tabs' worth of components (and their effects) alive always, and
  `YouTubeTab`'s `autoFocus`/form behavior gets awkward. Lifting just the job is
  more surgical.

## The `useActiveJob` hook

Replaces both the per-tab `useState<JobStatus>` AND `useJobSubscription`. It
encapsulates everything the three tabs duplicate today.

```ts
type OwnerTab = 'youtube' | 'http' | 'bt'

function useActiveJob() {
  const [job, setJob] = useState<JobStatus | null>(null)
  const [ownerTab, setOwnerTab] = useState<OwnerTab | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const autoTriggeredRef = useRef<string | null>(null)  // job_id already auto-downloaded

  // Close the stream when App unmounts (i.e. never, in practice).
  useEffect(() => () => esRef.current?.close(), [])

  // Called by a tab when the user clicks Start. `starter` does the API call
  // and returns a job_id; `initial` is the queued JobStatus to show immediately.
  async function start(
    owner: OwnerTab,
    starter: () => Promise<string>,
    initial: JobStatus,
  ): Promise<void> {
    esRef.current?.close()
    autoTriggeredRef.current = null
    setOwnerTab(owner)
    setJob(initial)
    const jobId = await starter()
    setJob({ ...initial, id: jobId })   // patch in the real id
    subscribe(jobId)
  }

  function subscribe(jobId: string) {
    const es = new EventSource(`/api/jobs/${jobId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as JobStatus
      setJob(j)
      // Auto-download only the original single-file job, once, on the Start
      // gesture's tick - NOT on restore. Guarded by autoTriggeredRef.
      if (j.status === 'done' && autoTriggeredRef.current !== jobId) {
        const urls = j.download_urls?.length ? j.download_urls : (j.download_url ? [j.download_url] : [])
        if (urls.length === 1) {
          autoTriggeredRef.current = jobId
          triggerDownload(urls[0])
        }
      }
      if (j.status === 'done' || j.status === 'error') es.close()
    }
    es.onerror = () => es.close()
  }

  function reset() {
    esRef.current?.close()
    esRef.current = null
    autoTriggeredRef.current = null
    setJob(null)
    setOwnerTab(null)
  }

  // A tab passes its identity; gets back only the job if it owns it.
  function jobFor(tab: OwnerTab): JobStatus | null {
    return ownerTab === tab ? job : null
  }

  return { jobFor, start, reset, isRunning: !!job && job.status === 'running' }
}
```

### Why auto-download still works (and doesn't misfire on restore)

The auto-trigger fires inside `subscribe`'s `onmessage`, which only runs while
the SSE stream is open. The stream stays open across tab switches now (it lives
in App). Critically, `autoTriggeredRef` is keyed by `jobId` and set the first
time `done` arrives - so:

- **Normal**: Start click -> stream opens -> `done` arrives -> auto-download
  fires once, ref set. ✓
- **Restore after done**: user switches away, job finishes while away (stream
  still open, `done` already processed, ref already set, stream closed). User
  switches back -> `jobFor` returns the `done` job -> `JobView` shows Download
  button. No `subscribe` re-open, no second auto-download. ✓
- **Restore before done**: stream still open, `onmessage` keeps updating `job`
  -> `jobFor` returns live progress. ✓

So the `autoTriggeredRef` guard (already present in the current hook) plus
"stream lives in App" together satisfy R4 with no extra logic.

## Tab changes (all three, mechanical)

Each tab drops its local `useState<JobStatus>` and `useJobSubscription` call,
and instead receives `{ jobFor, start, reset }` (or a tailored subset) as props
from `App`. Concretely:

- `YouTubeTab`: `const [job] = ...` + `useJobSubscription` -> receives
  `activeJob` (= `jobFor('youtube')`) and a `startJob` that wraps
  `startDownload`/`startBatch`. The `resetJob()` local helper calls the passed
  `reset`. Form state stays local.
- `HttpTab`: same, `startJob` wraps `startHttpDownload`.
- `BtTab`: same, `startJob` wraps `startBtMagnet`/`startBtTorrentFile`.

`App.tsx` instantiates `const active = useActiveJob()` once and passes the
relevant pieces to whichever tab is rendered. (Only the rendered tab needs them,
but passing to all is harmless since unmounted tabs ignore props.)

`useJobSubscription.ts` is **deleted** - its logic folds into `useActiveJob`.

## Edge cases

- **Starting a new job while one runs**: `start()` closes the old stream and
  overwrites `job`/`ownerTab`. The old owning tab, if revisited, shows nothing
  (its `jobFor` now returns null because `ownerTab` changed). This matches "one
  active job at a time" (R3) and current behavior. The old backend job keeps
  running (no cancel API exists) - same as today; out of scope.
- **`isRunning` for disabling Start buttons**: each tab currently checks
  `job.status === 'running'` to disable its Start button. With a shared job, a
  running job on tab A would also disable B's Start button. **Decision**: disable
  only based on the *owning* tab's job, i.e. a tab's Start is disabled iff
  `jobFor(thisTab)?.status === 'running'`. Starting a job on B while A runs is
  allowed (it replaces A's job). This keeps each tab self-gated. (Alternative:
  globally disable all Starts while any job runs - rejected as too restrictive;
  a user may want to queue a BT job while a YouTube one finishes.)

## Files

- `frontend/src/useActiveJob.ts` (new) - the hook above.
- `frontend/src/useJobSubscription.ts` - **deleted** (logic folded in).
- `frontend/src/App.tsx` - instantiate `useActiveJob()`, pass to rendered tab.
- `frontend/src/YouTubeTab.tsx`, `HttpTab.tsx`, `BtTab.tsx` - accept props,
  drop local job state + subscription.
- `frontend/src/types.ts` - add `OwnerTab` type (or reuse `Tab` from i18n).

## Rollback

Pure frontend refactor, additive hook + prop threading. Revert the commits; no
backend or data change. `useJobSubscription` deletion is the only removal - keep
it in git history (it is).

## Trade-offs

- **Props vs Context**: chose props (explicit, fewer moving parts, only 3
  consumers). If a 4th tab or a header-level job indicator is added later,
  revisit toward Context.
- **One active job**: lifted state is singular. If multi-job ever needed, the
  store becomes a `Record<jobId, JobStatus>` - but that's a bigger change and
  not needed now.
