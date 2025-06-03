const { Client, GatewayIntentBits, VoiceChannel } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} = require("@discordjs/voice");
const ytdl = require("ytdl-core");
const ytSearch = require("yt-search");
const { EmbedBuilder } = require("discord.js");
const { spawn } = require("child_process");

require("dotenv/config");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let queue = [];
let player = createAudioPlayer();
let connection = null;
let lastChannel = null;

client.on("ready", () => {
  console.log("Im chillin");
});

client.on("messageCreate", async (message) => {
  message.react("🦧").then(console.log);

  if (message.content.startsWith("!skip")) {
    playNext(message.channel);
    return;
  }

  if (message.content.startsWith("!queue")) {
    printQueue(message.channel);
  }

  if (!message.content.startsWith("!spela") || message.author.bot) return;

  const query = message.content.slice("!spela".length).trim();
  if (!query) return message.reply("provide a term or youtube url");

  const channel = message.member.voice.channel;
  if (!channel) return message.reply("join a voice channel forst");

  try {
    let url, title;
    if (ytdl.validateURL(query)) {
      url = query;
      const info = await ytdl.getInfo(url);
      title = info.videoDetails.title;
    } else {
      const result = await ytSearch(query);
      if (!result.videos.length) return message.reply("**none** found");
      url = result.videos[0].url;
      console.log("URL: " + url);
      title = result.videos[0].title;
    }

    queue.push({ url: url, title: title });

    if (!connection) {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });

      connection.subscribe(player);
    }

    if (player.state.status !== AudioPlayerStatus.Playing) {
      playNext(message.channel);
    } else {
      message.channel.send(`queued: **${title}**`);
      printQueue(message.channel);
    }
  } catch (e) {
    console.error("Stream/play error:", e);
    try {
      connection?.destroy();
    } catch (err) {
      console.warn("Connection cleanup failed:", err);
    }
    try {
      await message.reply("play error");
    } catch (err) {
      console.warn("Couldn't send error reply:", err);
    }
  }
});

function printQueue(channel) {
  const queueEmbed = new EmbedBuilder()
    .setColor("#0099ff")
    .setTitle("Music Queue");

  if (queue.length === 0) {
    queueEmbed.setDescription("The queue is empty!");
  } else {
    const queueList = queue
      .slice(0, 25)
      .map((song, index) => {
        return `**${index + 1}.** [${song.title}](${song.url})`;
      })
      .join("\n");

    queueEmbed.setDescription(queueList);
  }

  channel.send({ embeds: [queueEmbed] });
}

function playNext(channel) {
  if (queue.length === 0) {
    connection?.destroy();
    connection = null;
    return;
  }

  const next = queue[0];

  const stream = spawn("yt-dlp", [
    "-f",
    "bestaudio",
    "--no-playlist",
    "-o",
    "-", // output to stdout
    next.url,
  ]);

  const resource = createAudioResource(stream.stdout);
  player.play(resource);

  if (channel) {
    channel.send(`playing: **${next.title}**`);
    lastChannel = channel;
  } else if (lastChannel) {
    lastChannel.send(`playing: **${next.title}**`);
  }

  stream.stderr.on("data", (data) => {
    console.error(`yt-dlp error: ${data}`);
  });

  stream.on("error", (err) => {
    console.error("Failed to start yt-dlp:", err);
  });
}

player.on(AudioPlayerStatus.Idle, () => {
  queue.shift();
  playNext();
});

client.login(process.env.TOKEN);
