# Badger2040 companion

Display a compact Flight Recorder summary on a USB-connected Pimoroni Badger2040
or Badger2040 W: run status, agent, event/token counts, latency, estimated cost,
the first recorded alert and a short run ID.

## Device setup

Use current [Pimoroni Badger firmware](https://github.com/pimoroni/badger2040/releases/latest)
with the `badger2040` module and PicoGraphics API. The older firmware with `pen()`
and `font()` methods is not supported. No Wi-Fi configuration is needed.

Back up your existing device files first. Firmware labeled `with-badger-os`
overwrites the device filesystem, and installing this app as `main.py` replaces
the existing startup app. Use Thonny or `mpremote` to put both files in the device
root:

- [flight_badge.py](flight_badge.py)
- [main.py](main.py)

For example, after installing `mpremote` in your own Python environment and
replacing COM5 with the badge's port:

```powershell
mpremote connect COM5 fs cp integrations/badger2040/flight_badge.py :flight_badge.py
mpremote connect COM5 fs cp integrations/badger2040/main.py :main.py
mpremote connect COM5 reset
```

Close Thonny or any other serial console before starting the bridge. The display
shows **WAITING** until a valid summary arrives. Keep USB connected while watching;
the image remains on e-ink after power is removed, but it is no longer live.

## Host bridge

Start the Docker recorder and create or record a run. From the repository root:

```powershell
docker compose up --build --detach
npm ci
npm run badger -- --list
npm run badger -- --port COM5 --watch
```

The default server is `http://localhost:5080`. Set `FLIGHTRECORDER_URL` or use
`--url` for another HTTPS or loopback HTTP origin; `--url` takes precedence.
Remove a stale override to use Docker's default. `--run-id <uuid>` pins a specific run; otherwise the latest
run is used. Omit `--watch` to send one update. Linux/macOS ports typically look
like `/dev/ttyACM0` or `/dev/cu.usbmodem...`; select the actual port shown by
`--list`. Serial access permissions are managed by your operating system.

Polling defaults to 30 seconds, accepts `--interval` values of at least 15 seconds,
and skips unchanged frames. The device also skips duplicate summaries and
periodically performs a normal refresh to reduce ghosting. Ctrl+C stops the host
bridge without clearing the display.

Without hardware, preview the exact wire frame:

```powershell
npm run badger -- --stdout
npm run test:badger
```

## Protocol and limits

The bridge sends newline-delimited UTF-8 JSON over USB CDC at 115200 baud. Protocol
version 2 uses the same fields as version 1: `version`, `runId`, `agent`, `status`,
`eventCount`, `tokens`, `durationSeconds`, `estimatedCost` and `alert`. The bridge
preserves the supplied protocol version; both the bridge and receiver accept
versions 1 and 2 and reject unsupported versions.

In version 2, `tokens` and `estimatedCost` must each be present, but may be an
explicit JSON `null` when usage is **Not reported** or only partially reported.
The display shows `? tokens` and/or `USD ?`, independently. Complete reported
values, including zero, remain numeric and appear as `0 tokens` / `USD 0.0000`
when zero. In both versions, positive costs below USD 0.0001 display as
`USD <0.0001`, rather than rounding to zero. Missing fields are rejected rather
than treated as null, so an incomplete or malformed contract is not silently
presented as unreported usage.
`eventCount` and `durationSeconds` remain required numbers in both versions.
All numeric metrics must be finite, nonnegative and no greater than
9,007,199,254,740,991; event and token counts must be integers. Strings and booleans
are not accepted as numbers.

Version 1 still requires numeric tokens and cost. Legacy values, including zero,
are preserved as received: a legacy zero cannot establish whether usage was
actually reported, and the bridge does not infer or rewrite it. Upgrade the host
bridge and both badge app files together before connecting to an API that emits
version 2. Older bridge/device code rejects version 2 even when its metrics are
numeric; the updated consumers remain compatible with version 1 APIs.

Text is ASCII-normalized and capped at 28 characters for the agent and 64 for the
alert. Frames remain limited to 1024 bytes. The display measures text before
rendering so long values fit the screen.
Malformed or oversized frames are rejected; reception resumes at the next newline.
The device replies with `OK` or `ERR frame` without echoing trace content.

The bridge never sends prompts, responses, attributes or credentials. Redaction
happens in the recorder, with a second field allowlist in the bridge and receiver.
The badge is physically readable by anyone nearby: even compact metadata may be
sensitive. There is no device-side authorization, storage encryption or proof of
delivery in the host bridge. Unplugging the device does not erase the last image.

Decoder and layout tests run on CPython without the hardware module. They verify
framing, malformed data recovery, allowlisting and measured screen bounds; they do
not replace testing USB reception and e-ink refresh on a physical device.

API references: [Badger2040](https://github.com/pimoroni/badger2040/blob/main/docs/reference.md)
and [PicoGraphics](https://github.com/pimoroni/pimoroni-pico/blob/main/micropython/modules/picographics/README.md).