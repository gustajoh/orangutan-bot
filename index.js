require("dotenv/config");

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const ytdlp = require("yt-dlp-exec");
const ytSearch = require("yt-search");
const fs = require("fs");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let queue = [];
let session = [];
const player = createAudioPlayer();
let connection = null;
let lastChannel = null;
let leaveTimeout = null;

/* ---------- utils ---------- */

const isYouTubeUrl = (str) =>
  /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(str);

const isSpotifyUrl = (str) =>
  /^(https?:\/\/)?open\.spotify\.com\/track\//i.test(str);

let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
        ).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

async function resolveSpotifyUrl(url) {
  const trackId = url.match(/\/track\/([^?/]+)/)?.[1];
  if (!trackId) return null;
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const track = await res.json();
  return `${track.artists[0].name} - ${track.name}`;
}

function spawnYtdlpProcess(url) {
  // Prefer opus-in-webm for low CPU and direct playback; fall back to bestaudio
  const flags = {
    f: "251/bestaudio[ext=webm]",
    o: "-",
    extractorArgs: "youtube:player_client=android_vr",
  };
  if (fs.existsSync("cookies.txt")) flags.cookies = "cookies.txt";

  return ytdlp.exec(url, flags, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
}

/* ---------- bot ---------- */

client.on("ready", () => {
  console.log("Im chilled");
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  message.react("🦧").catch(() => {});

  const [cmd, ...args] = message.content.trim().split(/\s+/);
  const query = args.join(" ");

  switch (cmd) {
    case "!skip":
      if (queue.length) queue.shift();
      playNext(message.channel);
      return;

    case "!queue":
      printQueue(message.channel);
      return;

    case "!session":
    case "!log":
    case "!sesh":
      printSession(message.channel);
      return;

    case "!help":
      printCommands(message.channel);
      return;

    case "!mixtra":
      swapTracks(message.channel, args);
      return;

    case "!spela":
      handlePlay(message, query);
      break;

    default:
      return;
  }
});

async function handlePlay(message, query) {
  if (!query) {
    await message.reply("provide a term or youtube url");
    return;
  }

  const channel = message.member?.voice?.channel;
  if (!channel) {
    await message.reply("join a voice channel forst");
    return;
  }

  try {
    const { url, title } = await fetchSongDetails(query, message);

    queue.push({ url, title });
    session.push({
      msgAuthor: message.member.displayName,
      title: title,
      songUrl: url,
    });

    await enterChannel(channel);

    if (player.state.status !== AudioPlayerStatus.Playing) {
      playNext(message.channel);
    } else {
      await message.channel.send(`queued: **${title}**`);
      printQueue(message.channel);
    }
  } catch (e) {
    console.error("Add/queue error:", e);
    safeDestroyConnection();
    try {
      await message.reply("play error");
    } catch {}
  }
}

async function fetchSongDetails(query, message) {
  let url, title;

  if (isYouTubeUrl(query)) {
    url = query;
    const vidMatch = url.match(/(?:[?&]v=|youtu\.be\/)([^?&/]+)/);
    if (vidMatch) {
      const info = await ytSearch({ videoId: vidMatch[1] });
      title = info?.title || null;
    }
  } else if (isSpotifyUrl(query)) {
    const searchQuery = await resolveSpotifyUrl(query);
    if (!searchQuery) {
      await message.reply("could not resolve spotify link");
      return;
    }

    const result = await ytSearch(searchQuery);
    if (!result.videos.length) {
      await message.reply("**none** found");
      return;
    }

    url = result.videos[0].url;
    title = result.videos[0].title;
  } else {
    const result = await ytSearch(query);

    if (!result.videos.length) {
      await message.reply("**none** found");
      return;
    }

    url = result.videos[0].url;
    title = result.videos[0].title;
  }

  if (!title) title = "unknown title";
  return { url: url, title: title };
}

async function enterChannel(channel) {
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      debug: true,
    });
    connection.subscribe(player);
    connection.on("stateChange", (oldState, newState) => {
      console.log(`[connection] ${oldState.status} -> ${newState.status}`);
      if (newState.status === "connecting") {
        const networking = Reflect.get(newState, "networking");
        networking?.once("close", (code) => {
          console.log(`[voice WS closed] code: ${code}`);
        });
      }
    });
    connection.on("debug", (msg) => console.log("[voice debug]", msg));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      console.log("[connection] ready");
    } catch (e) {
      console.error("[connection] failed to reach Ready:", e);
      safeDestroyConnection();
      await message.reply("could not connect to voice channel");
      return;
    }
  }
}

function printSession(channel) {
  const sessionEmbed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle("session log");

  if (session.length === 0) {
    sessionEmbed.setDescription("log empty");
  } else {
    const sessionList = session
      .map(
        (tuple, index) =>
          `**${index + 1}.** ${tuple.msgAuthor} - [${tuple.title}](${tuple.songUrl})`,
      )
      .join("\n");
    sessionEmbed.setDescription(sessionList);
  }

  channel.send({ embeds: [sessionEmbed] }).catch(() => {});
}

function printQueue(channel) {
  const queueEmbed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle("Music Queue");

  if (queue.length === 0) {
    queueEmbed.setDescription("The queue is empty!");
  } else {
    const queueList = queue
      .slice(0, 25)
      .map((song, index) => `**${index + 1}.** [${song.title}](${song.url})`)
      .join("\n");
    queueEmbed.setDescription(queueList);
  }

  channel.send({ embeds: [queueEmbed] }).catch(() => {});
}

function swapTracks(channel, args) {
  const tracks = args.map((arg) => Number(arg));
  if (validateArgs(tracks)) {
    const a = tracks[0] - 1;
    const b = tracks[1] - 1;
    [queue[a], queue[b]] = [queue[b], queue[a]];
    channel.send(`swapped **${a + 1}** and **${b + 1}**`);
    printQueue(channel);
  } else {
    channel.send("Invalid arguments");
  }
}

function printCommands(channel) {
  channel
    .send({
      embeds: [
        new EmbedBuilder()
          .setColor("#0099ff")
          .setTitle("Commands")
          .setDescription(
            [
              "**!spela** `song/url` — play or queue a song",
              "**!skip** — skip the current song",
              "**!queue** — show the queue",
              "**!mixtra** `pos1 pos2` — swap two queued songs",
              "**!help** — show this message",
            ].join("\n"),
          ),
      ],
    })
    .catch(() => {});
}

function validateArgs(tracks) {
  const first = tracks[0];
  const second = tracks[1];

  return (
    !isNaN(first) &&
    !isNaN(second) &&
    first >= 2 &&
    second >= 2 &&
    first <= queue.length &&
    second <= queue.length
  );
}

function playNext(channel) {
  if (queue.length === 0) {
    player.stop();
    leaveTimeout = setTimeout(
      () => {
        safeDestroyConnection();
        leaveTimeout = null;
      },
      5 * 60 * 1000,
    );
    return;
  }
  if (leaveTimeout) {
    clearTimeout(leaveTimeout);
    leaveTimeout = null;
  }

  const next = queue[0];
  console.log(`[playNext] starting: ${next.title} | ${next.url}`);

  // Spawn yt-dlp and pipe stdout to Discord audio resource
  const proc = spawnYtdlpProcess(next.url);
  console.log(`[playNext] yt-dlp spawned, pid: ${proc.pid}`);

  proc.on("error", (err) => {
    console.error("yt-dlp spawn error:", err);
    queue.shift();
    playNext(channel);
  });

  proc.on("close", (code) => {
    console.log(`[yt-dlp] process exited with code ${code}`);
  });

  proc.stdout.once("data", () => {
    console.log("[yt-dlp] stdout receiving data");
  });

  proc.stdout.on("error", (err) => {
    console.error("[yt-dlp] stdout error:", err);
  });

  proc.stderr.on("data", (d) => {
    const s = d.toString();
    if (!/^\s*$/.test(s)) console.warn("[yt-dlp]", s.trim());
  });

  const resource = createAudioResource(proc.stdout, {
    inputType: StreamType.WebmOpus,
  });

  resource.playStream.on("error", (err) => {
    console.error("[resource] stream error:", err);
  });

  player.play(resource);
  console.log(`[player] play() called, state: ${player.state.status}`);

  if (channel) {
    channel.send(`playing: **${next.title.toLowerCase()}**`).catch(() => {});
    lastChannel = channel;
  } else if (lastChannel) {
    lastChannel
      .send(`playing: **${next.title.toLowerCase()}**`)
      .catch(() => {});
  }
}

player.on("stateChange", (oldState, newState) => {
  console.log(`[player] ${oldState.status} -> ${newState.status}`);
});

/* advance when the current stream ends */
player.on(AudioPlayerStatus.Idle, () => {
  if (queue.length) queue.shift();
  playNext(lastChannel);
});

/* log player errors but keep bot alive */
player.on("error", (error) => {
  console.error("Audio player error:", error);
  if (queue.length) queue.shift();
  playNext(lastChannel);
});

function safeDestroyConnection() {
  try {
    connection?.destroy();
  } catch {}
  connection = null;
}

client.login(process.env.TOKEN);
