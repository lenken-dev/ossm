import { useEffect, useRef, useState, type Dispatch, type PointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { Box, Button, Flex, IconButton, Popover, Text, TextField } from "@radix-ui/themes";
import { Crosshair2Icon, GearIcon, OpenInNewWindowIcon, PauseIcon, PlayIcon, TrackNextIcon, TrackPreviousIcon } from "@radix-ui/react-icons";
import { usePersistedState } from "../hooks/usePersistedState";
import { useMediaFile } from "../hooks/useMediaFile";
import { clamp, type Action } from "../funscript/model";
import { dragHeight } from "../drag";
import { ResizeGrip } from "../widgets";
import { byTime } from "./model";
import { FOLLOW_AT } from "./viewport";

/** Default and smallest height of the reference video, in px. */
const VIDEO_HEIGHT = 300;
const VIDEO_MIN_HEIGHT = 80;
/** Time steps of the seek buttons, in s, as typed; the first is always shown, empty ones are hidden. */
const DEFAULT_STEPS = ["1", "", ""];

/** The reference video or audio: its file and element, its playback, the player's height and seek steps, and the playhead's time. */
export interface Media {
  videoRef: RefObject<HTMLMediaElement | null>;
  videoFile: File | null;
  videoUrl: string | null;
  /** An audio file plays in a bar instead of the video area. */
  isAudio: boolean;
  paused: boolean;
  pip: boolean;
  /** Hidden, the video or audio and its controls leave their room to the graph. */
  playerShown: boolean;
  /** Hide the player, pausing it, or show it. */
  togglePlayer(): void;
  videoHeight: number;
  steps: string[];
  setSteps: Dispatch<SetStateAction<string[]>>;
  /** The steps in use; a first step that is not a positive number falls back to the default. */
  shownSteps: number[];
  /** Video time, in ms. */
  time: number;
  setTime: Dispatch<SetStateAction<number>>;
  /** Video length, in ms; 0 without one. */
  videoDuration: number;
  /** Move the playhead to `t` ms, within the media. */
  seek(t: number): void;
  /** Drag the bottom edge of the video to set its height; at most most of the window. */
  dragVideoHeight(e: PointerEvent<HTMLElement>): void;
  /** Props for the `<video>` or `<audio>` element. */
  mediaProps: { ref: (el: HTMLMediaElement | null) => void; src: string | undefined; controls: boolean; onPlay: () => void; onPause: () => void; onEmptied: () => void; onDurationChange: () => void; onSeeked: () => void };
  /** Close the media, pausing it. */
  close(): void;
  /** Ask for a media file to open, paused at its start, and show the player. */
  chooseFile(): void;
  /** The hidden file input `chooseFile` opens. */
  fileInput: ReactNode;
}

/**
 * The reference video or audio: its file, element and playback, its heights
 * and seek steps, kept across reloads, and the playhead's time; seeking while
 * paused brings the playhead into the view `setView` sets.
 */
export function useMediaPlayer(setView: Dispatch<SetStateAction<{ from: number; span: number }>>): Media {
  const videoRef = useRef<HTMLMediaElement>(null);
  /** Separate from the player's sizes. */
  const [normalHeight, setNormalHeight] = usePersistedState("ossm:editorVideoHeight", VIDEO_HEIGHT, localStorage);
  /** The video left in the page while it plays picture-in-picture has a height of its own. */
  const [pipHeight, setPipHeight] = usePersistedState("ossm:editorVideoPipHeight", VIDEO_MIN_HEIGHT, localStorage);
  const [paused, setPaused] = useState(true);
  const [pip, setPip] = useState(false);
  const [playerShown, setPlayerShown] = useState(true);
  const togglePlayer = () => {
    if (playerShown) videoRef.current?.pause();
    setPlayerShown(!playerShown);
  };
  const [videoHeight, setVideoHeight] = pip ? [pipHeight, setPipHeight] : [normalHeight, setNormalHeight];
  const [steps, setSteps] = usePersistedState("ossm:editorSteps", DEFAULT_STEPS, localStorage);
  const shownSteps = steps.map(Number).map((v, i) => (v > 0 ? v : i === 0 ? Number(DEFAULT_STEPS[0]) : null)).filter((v) => v !== null);
  const [time, setTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const { file: videoFile, url: videoUrl, isAudio, choose: chooseFile, close, input: fileInput } = useMediaFile((file) => {
    setPaused(true);
    if (!file) return;
    setTime(0);
    setPlayerShown(true);
  });

  // Picture-in-picture events bubble, so the document sees them for whichever video is shown.
  useEffect(() => {
    const update = () => setPip(!!document.pictureInPictureElement);
    document.addEventListener("enterpictureinpicture", update);
    document.addEventListener("leavepictureinpicture", update);
    return () => {
      document.removeEventListener("enterpictureinpicture", update);
      document.removeEventListener("leavepictureinpicture", update);
    };
  }, []);

  /** Seeking while paused brings the playhead into view. */
  const seeked = () => {
    const t = (videoRef.current?.currentTime ?? 0) * 1000;
    setTime(t);
    setView((v) => (t < v.from || t > v.from + v.span ? { ...v, from: Math.max(t - v.span * FOLLOW_AT, 0) } : v));
  };

  const dragVideoHeight = (e: PointerEvent<HTMLElement>) => dragHeight(e, videoHeight, setVideoHeight, VIDEO_MIN_HEIGHT);

  const seek = (t: number) => {
    const media = videoRef.current;
    if (!media) return;
    t = clamp(t, 0, (media.duration || 0) * 1000);
    media.currentTime = t / 1000;
    setTime(t);
  };

  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => void (videoRef.current = el),
    src: videoUrl ?? undefined,
    controls: true,
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onEmptied: () => (setPaused(true), setVideoDuration(0)),
    onDurationChange: () => setVideoDuration((videoRef.current?.duration || 0) * 1000),
    onSeeked: seeked,
  };

  return { videoRef, videoFile, videoUrl, isAudio, paused, pip, playerShown, togglePlayer, videoHeight, steps, setSteps, shownSteps, time, setTime, videoDuration, seek, dragVideoHeight, mediaProps, close, chooseFile, fileInput };
}

/**
 * The reference video or audio, with its resize grip, and its seek-step
 * controls, `view` for moving the playhead into view and `actions` for the
 * previous and next point; and the file input `media.chooseFile` opens.
 */
export function MediaPlayer({ media, actions, view }: { media: Media; actions: Action[]; view: { from: number; span: number } }) {
  const { videoRef, videoUrl, isAudio, paused, pip, playerShown, videoHeight, steps, setSteps, shownSteps, time, seek, dragVideoHeight, mediaProps, fileInput } = media;
  /** The point after (`dir` 1) or before (-1) the playhead; half a ms of slack for the media's rounding. */
  const neighbour = (dir: 1 | -1) => actions[dir > 0 ? byTime(actions, time + 0.5) : byTime(actions, time - 0.5) - 1];

  return (
    // Hidden, not unmounted, so the media stays loaded; without media, so it leaves no gap.
    <Flex direction="column" gap="3" flexShrink="0" display={videoUrl && playerShown ? undefined : "none"}>
      {fileInput}
      {videoUrl && isAudio && <audio {...mediaProps} style={{ width: "100%", flexShrink: 0 }} />}
      {videoUrl && !isAudio && (
        <Box position="relative" flexShrink="0">
          <video {...mediaProps} style={{ display: "block", width: "100%", height: videoHeight, background: "black", borderRadius: 6 }} />
          <ResizeGrip edge="bottom" onPointerDown={dragVideoHeight} />
        </Box>
      )}
      {videoUrl && (
        <Flex align="center" justify="center" gap="2" flexShrink="0">
          {/* The first step nearest the middle. */}
          {[...shownSteps].reverse().map((step, i) => (
            <Button key={`back${i}`} variant="soft" onClick={() => seek(time - step * 1000)}>
              −{step}s
            </Button>
          ))}
          <IconButton variant="soft" aria-label="Previous point" title="Previous point" disabled={!neighbour(-1)} onClick={() => seek(neighbour(-1).at)}>
            <TrackPreviousIcon />
          </IconButton>
          <IconButton
            aria-label={paused ? "Play" : "Pause"}
            onClick={() => (paused ? void videoRef.current?.play() : videoRef.current?.pause())}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton variant="soft" aria-label="Next point" title="Next point" disabled={!neighbour(1)} onClick={() => seek(neighbour(1).at)}>
            <TrackNextIcon />
          </IconButton>
          {shownSteps.map((step, i) => (
            <Button key={`fwd${i}`} variant="soft" onClick={() => seek(time + step * 1000)}>
              +{step}s
            </Button>
          ))}
          <IconButton
            variant="soft"
            color="gray"
            aria-label="Playhead to view"
            title="Move the playhead into view"
            disabled={time >= view.from && time <= view.from + view.span}
            onClick={() => seek(view.from + view.span * FOLLOW_AT)}
          >
            <Crosshair2Icon />
          </IconButton>
          {!isAudio && document.pictureInPictureEnabled && (
            <IconButton
              variant={pip ? "solid" : "soft"}
              color="gray"
              aria-label="Picture in picture"
              aria-pressed={pip}
              title="Picture in picture"
              onClick={() => void (pip ? document.exitPictureInPicture() : (videoRef.current as HTMLVideoElement).requestPictureInPicture())}
            >
              <OpenInNewWindowIcon />
            </IconButton>
          )}
          <Popover.Root>
            <Popover.Trigger>
              <IconButton variant="soft" color="gray" aria-label="Step settings">
                <GearIcon />
              </IconButton>
            </Popover.Trigger>
            <Popover.Content width="220px">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium">Seek steps</Text>
                {steps.map((step, i) => (
                  <TextField.Root
                    key={i}
                    type="number"
                    min={0}
                    step="any"
                    placeholder={i === 0 ? DEFAULT_STEPS[0] : "Off"}
                    aria-label={`Step ${i + 1}`}
                    value={step}
                    onChange={(e) => setSteps(steps.map((s, j) => (j === i ? e.target.value : s)))}
                  >
                    <TextField.Slot side="right">s</TextField.Slot>
                  </TextField.Root>
                ))}
                <Text size="1" color="gray">The first step is always shown; leave the others empty to hide them.</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>
        </Flex>
      )}
    </Flex>
  );
}
