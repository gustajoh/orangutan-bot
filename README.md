# orangutan-bot

music bot for discord

### .env requirements

TOKEN=\<discord bot token>  
SPOTIFY_CLIENT_ID=\<spotify web api client id>  
SPOTIFY_CLIENT_SECRET=\<spotify web api client secret>

spotify client keys makes it possible to queue songs using spotify links,  
you can create such keys [here](https://developer.spotify.com/documentation/web-api)

### commands

- !spela - play song
- !skip - skip song
- !mixtra \<i> \<j> swap songs with indexes _i_, _j_ in the queue
- !queue print current queue
- !session list all tracks played in current session
