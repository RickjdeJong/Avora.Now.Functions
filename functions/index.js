const functions = require('firebase-functions');
const request = require("request");
const express = require("express");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const youtube_search = require('youtube-search');
const admin = require('firebase-admin');
const path = require("path");
const { google } = require('googleapis');

/*** Global vars ***/
const spotify_client_id = "e65f45321c0b465d8d551ba1d8d92750";
const spotify_client_secret = "d961083c520644049e71d7c6d1ec4a55";
const youtube_api_key = "AIzaSyD8sZkYcbYtBmCeHCa_9gyd9-dLmHxe81Y";
const youtube_alt_api_key = "AIzaSyDq04JBJ5AINxqgv_pZO_7icHVShWjk8vQ";
const apple_music_privatekey = fs.readFileSync(path.join(__dirname, "/AuthKey.p8"));
const apple_music_config = {
	teamId: "5RC4LMP76D",
	keyId: "5878R7XNNA"
};
var properRequestParams = "";
const apple_music_jwt = jwt.sign({}, apple_music_privatekey, {
	algorithm: "ES256",
	expiresIn: "180d",
	issuer: apple_music_config.teamId,
	header: {
		alg: "ES256",
		kid: apple_music_config.keyId
	}
});
const spotify_auth_options = {
	url: "https://accounts.spotify.com/api/token",
	headers: {
		Authorization: "Basic " +
			new Buffer(spotify_client_id + ":" + spotify_client_secret).toString(
				"base64"
			)
	},
	form: {
		grant_type: "client_credentials"
	},
	json: true
};


const regexkeys = {
	"spotify": /^(https:\/\/open.spotify.com\/user\/([a-zA-Z0-9]+)\/playlist\/|spotify:user:spotify:playlist:)([a-zA-Z0-9]+)(.*)$/m,
	"soundcloud": /(snd\.sc|soundcloud\.com)/,
	"youtube": /[?&]list=([^#\&\?]+)/
};

var savedTrackName;

var startTime;
admin.initializeApp();
const db = admin.firestore();
const app = express();
//app.use(cors)
exports.api = functions.https.onRequest(app);

// Create api endpoint
app.get("/gettrack/:trackname", function (req, res) {
	res.set('Access-Control-Allow-Origin', '*');
	if (req.param("trackname")) {
		startTime = new Date();
		getTrack(req.param("trackname"), false).then(function (results) {
			const endTime = new Date();
			results["speed"] = {
				"startTime": startTime,
				"endTime": endTime,
				"diff": Math.abs(startTime.getTime() - endTime.getTime())
			};
			res.send(results);
		});
	} else {
		res.status(500).send("No trackname provided");
	}
});

app.get("/getrawtrack/:trackname", function (req, res) {
	res.set('Access-Control-Allow-Origin', '*');
	if (req.param("trackname")) {
		getTrack(req.param("trackname"), true).then(function (results) {
			res.send(results);
		});
	}
});

app.get("/getsearch/:trackname", function (req, res) {
	res.set('Access-Control-Allow-Origin', '*');
	if (req.param("trackname")) {
		startTime = new Date();
		getSearch(req.param("trackname")).then(function (results) {
			res.send(results);
		});
	} else {
		res.status(500).send("No trackname provided");
	}
});

app.get("/gettrackinfo/:trackid", function (req, res) {
	res.set('Access-Control-Allow-Origin', '*');
	if (req.param("trackid")) {
		startTime = new Date();
		getTrackId(req.param("trackid")).then(function (results) {
			res.send(results);
		});
	} else {
		res.status(500).send("No trackname provided");
	}
});

app.get("/getplaylist", function (req, res) {
	res.set('Access-Control-Allow-Origin', '*');
	var playlisturl = req.query.playlisturl;
	var regex = {
		spotify: {
			test: regexkeys.spotify.test(playlisturl),
			result: regexkeys.spotify.exec(playlisturl)
		},
		soundcloud: {
			test: regexkeys.soundcloud.test(playlisturl),
			result: regexkeys.soundcloud.exec(playlisturl)
		},
		youtube: {
			test: regexkeys.youtube.test(playlisturl),
			result: regexkeys.youtube.exec(playlisturl)
		},
	}


	if (regex.spotify.test) {
		var spotifyPlaylistId = regex.spotify.result[3];
		getSpotifyPlaylist(regex.spotify.result[3]).then(function (combResponseObject) {
			var playlistinfo = combResponseObject.playlistinfo
			var response = combResponseObject.response;

			let promiseArray = [];
			for (let i = 0; i < response.length; i++) {
				let sanitizedFullTrackName = response[i].track.artists[0].name + " " + response[i].track.name;
				promiseArray.push(getTrack(sanitizedFullTrackName, false));
			}

			var resultArray = [];
			Promise.all(promiseArray).then(function (results) {
				results.forEach(item => {
					resultArray.push(item);
				});
				

				let finalArray = [];

				for (let i = 0; i < resultArray.length; i++) {
					finalArray = finalArray.concat(resultArray[i]);
				}

				console.dir({
					info: playlistinfo,
					tracks: finalArray
				});
				res.send({
					info: playlistinfo,
					tracks: finalArray
				});
			})
			.catch(function (err) {
				console.log(err);
				res.status(500).send(err);
			});
		}, function (reject) {
			res.status(500).send(reject);
		});
	} else if (regex.soundcloud.test) { } else if (regex.youtube.test) { } else { }
});


/*** Playlist Logic ***/
function getSpotifyPlaylist(playlistId) {
	return new Promise((resolve, reject) => {
		// Check if PlaylistId provided
		console.log(playlistId);
		if (!playlistId) {
			reject("No playlistId provided");
		}

		var requestParameters = {
			method: "GET",
			url: "https://api.spotify.com/v1/playlists/" + playlistId + "/"
		}

		spotifyAuth(requestParameters).then(function (AuthResponse) {
			// Returns an authenticated response for your call.

			request.get(AuthResponse, function (error, response, body) {
				const playlistInfo = {
					description: body.description,
					name: body.name,
					followers: body.followers,
					public: body.public,
					owner: body.owner,
					id: body.id
				}

				if (!error && response.statusCode === 200) {
					var totalTracks = body.tracks.total;
					var promiseArray = [];
					var resultArray = [];

					for (let index = 0; index < totalTracks; index += 100) {
						promiseArray.push(pullBatch(AuthResponse, index));
					}

					Promise.all(promiseArray).then(function (results) {
						results.forEach(item => {
							resultArray.push(item);
						});

						let finalArray = [];

						for (let i = 0; i < resultArray.length; i++) {
							finalArray = finalArray.concat(resultArray[i]);
						}
						resolve({ response: finalArray, playlistinfo: playlistInfo });
					}).catch(function (err) {
						reject(err);
					});

				} else {
					reject(error + response.statusCode);
				}
			});
		}, function (reject) {
			reject(reject);
		});

	})
}

function pullBatch(localRequestParams, index) {
	return new Promise(function (resolve, reject) {
		var tracksArrayRaw = [];
		localRequestParams.url = localRequestParams.url.split('?')[0] + "tracks?offset=" + index;
		console.log(localRequestParams.url);

		request.get(localRequestParams, function (error, response, body) {
			if (!error && response.statusCode === 200) {
				body.items.forEach(item => {
					tracksArrayRaw.push(item);
				});
				resolve(tracksArrayRaw);
			} else {
				console.log(error);
				reject(error);
			}
		},
			function (error) {
				reject(error);
			});
	});
}

function spotifyAuth(requestParameters) {
	var requestParameters = requestParameters;
	return new Promise((resolve, reject) => {
		request.post(spotify_auth_options, function (error, response, body) {
			if (!error && response.statusCode === 200) {
				// use the access token to access the Spotify Web API
				var spotify_options = {
					method: requestParameters.method,
					url: requestParameters.url,
					headers: {
						Authorization: "Bearer " + body.access_token
					},
					json: true,
					mode: "cors",
					cache: "default"
				};
				resolve(spotify_options);
			} else {
				reject(error);
			}
		});
	})
}

function savePlaylist(receivedPlaylist, playlistinfo) {
	return new Promise((resolve, reject) => {
		var toSave = {
			info: playlistinfo,
			tracks: receivedPlaylist
		};

		console.dir(toSave);
		resolve(toSave)

		db.collection("playlists").doc(String(playlistinfo.id)).set(toSave)
		.then(function (response) {
			console.log("SAVED!");
			resolve({
				info: playlistinfo,
				tracks: receivedPlaylist
			});
		}).catch(function (err) {
			reject(err);
		});
	});
}


// General function
function getTrack(trackname, raw) {
	savedTrackName = trackname.replace(/ *\([^)]*\) */g, "");
	// TODO: ADD youTubeTrack(savedTrackName) back to array... after youtube api is fixed
	return new Promise((resolve, reject) => {
		Promise.all([spotifyTrack(savedTrackName), iTunesTrack(savedTrackName)]).then(function (result) {
			var result = {
				"spotify": result[0],
				"itunes": result[1],
				"youtube": result[2]
			}

			if (!raw) {
				resolve(sortResults(result, savedTrackName, false));
			} else {
				resolve(sortResults(result, savedTrackName, raw));
			}
		})
			.catch(function (err) {
				console.log(err);
				reject(err);
			});
	});
}

function getSearch(trackname) {
	return new Promise((resolve, reject) => {
		Promise.all([iTunesTrack(trackname)]).then(function (result) {
			resolve(result[0]);
		})
			.catch(function (err) {
				console.log(err);
				reject(err);
			});
	})
}

function getTrackId(trackid) {
	return new Promise((resolve, reject) => {
		Promise.all([iTunesInformation(trackid)]).then(function (result) {
			resolve(result[0]);
		})
			.catch(function (err) {
				reject(err);
			})
	})
}

//****** SPOTIFY SEARCH LOGIC ******//
function spotifyTrack(trackname) {
	return new Promise((resolve, reject) => {
		// Set up Auth options
		spotify_Track_Auth(trackname).then(
			function (spotify_options) {
				spotify_Track_Search(spotify_options).then(
					function (tracks) {
						resolve(tracks);
					},
					function (error) {
						throw new Error(error);
					}
				).catch(function (err) {
					reject(err);
				});
			}
		).catch(function (err) {
			reject(err);
		});
	});
}

function spotify_Track_Auth(trackname) {
	return new Promise((resolve, reject) => {
		request.post(spotify_auth_options, function (error, response, body) {
			if (!error && response.statusCode === 200) {
				// use the access token to access the Spotify Web API
				var spotify_options = {
					method: "GET",
					url: "https://api.spotify.com/v1/search?q=" + trackname + "&type=track,artist",
					headers: {
						Authorization: "Bearer " + body.access_token
					},
					json: true,
					mode: "cors",
					cache: "default"
				};
				resolve(spotify_options);
			} else {
				reject(error);
			}
		}, function (error) {
			reject(error);
		});
	});
}

function spotify_Track_Search(spotify_options) {
	return new Promise((resolve, reject) => {
		request.get(spotify_options, function (error, response, body) {
			if (!error && response.statusCode === 200) {
				resolve(body.tracks);
			} else {
				reject(error);
			}
		});
	});
}

//****** iTunes SEARCH LOGIC ******//
function iTunesTrack(trackname) {
	var iTunes_options = {
		method: "GET",
		url: "https://itunes.apple.com/search?term=" + trackname + "&limit=20&media=music",
		json: true,
		mode: "cors",
		cache: "default"
	};
	
	return new Promise((resolve, reject) => {
		request.get(iTunes_options, function (error, response, body) {
			if (!error && response.statusCode === 200) {
				resolve(body.results);
			} else {
				console.dir({
					iTunes_options: iTunes_options,
					error: error,
					response: response,
					body: body
				});
				reject(error);
			}
		})
	});
}

function iTunesInformation(trackid) {
	var iTunes_options = {
		method: "GET",
		url: "https://itunes.apple.com/lookup?id=" + trackid,
		json: true,
		mode: "cors",
		cache: "default"
	};

	return new Promise((resolve, reject) => {
		request.get(iTunes_options, function (error, response, body) {
			if (!error && response.statusCode === 200) {
				resolve(body.results);
			} else {
				console.log(error + response.statusCode);
				reject(error);
			}
		})
	});
}

//****** YouTube SEARCH LOGIC ******//
function youTubeTrack(trackname) {
	var youtube_search_option = {
		maxResults: 10,
		key: youtube_api_key
	};

	const youtube = google.youtube({
		version: 'v3',
		auth: youtube_alt_api_key,
	});

	return new Promise((resolve, reject) => {

		youtube.search.list({
			part: 'snippet',
			q: trackname,
			maxResults: 10
		}).then(function (response) {
			var resultArray = [];
			for (let i = 0; i < response.data.items.length; i++) {
				let item = response.data.items[i];
				if (item.id.kind = "youtube#video"); {
					resultArray.push({
						channelId: item.snippet.channelId,
						channelTitle: item.snippet.channelTitle,
						description: item.snippet.description,
						id: item.id.videoId,
						kind: item.id.kind,
						link: "https://www.youtube.com/watch?v=" + item.id.videoId,
						publishedAt: item.snippet.publishedAt,
						thumbnails: item.snippet.thumbnails,
						title: item.snippet.title
					});
				}
			}
			resolve(resultArray);
		}).catch(function (error) {
			console.log(error);
			reject(error)
		})

	});
}

//****** Sorting Results logic ******//

function sortResults(results, trackname, raw) {
	let badIndexSpotify = [];

	// Spotify logic
	if(results.spotify) {
		for (var i = 0; i < results.spotify.items.length; i++) {
			var objectToHandle = results.spotify.items[i];
			var resultString = objectToHandle.artists[0].name + " " + objectToHandle.name;
			var matchPercentage = Compare(resultString.replace(/[^a-zA-Z ]/g, ""), trackname.replace(/[^a-zA-Z ]/g, ""));
			objectToHandle["matchPercentage"] = matchPercentage;
			results.spotify.items[i] = objectToHandle;
	
			if (matchPercentage < 0.8 && !raw) {
				badIndexSpotify.push(i);
				results.spotify.items.splice(i, i + 1);
			}
		}
	}

	// iTunes logic
	if(results.itunes) {
		for (var i = 0; i < results.itunes.length; i++) {
			var objectToHandle = results.itunes[i];
			var resultString = objectToHandle.artistName + " " + objectToHandle.trackName;
			var matchPercentage = Compare(resultString.replace(/[^a-zA-Z ]/g, ""), trackname.replace(/[^a-zA-Z ]/g, ""));
			objectToHandle["matchPercentage"] = matchPercentage;
			results.itunes[i] = objectToHandle;
	
			if (matchPercentage < 0.8 && !raw) {
				results.itunes.splice(i, i + 1);
			}
		}
	}

	// YouTube Logic
	if(results.youtube) {
		for (var i = 0; i < results.youtube.length; i++) {
			var objectToHandle = results.youtube[i];
			var resultString = objectToHandle.title;
			var matchPercentage = Compare(resultString.replace(/[^a-zA-Z ]/g, ""), trackname.replace(/[^a-zA-Z ]/g, ""));
			objectToHandle["matchPercentage"] = matchPercentage;
			results.youtube[i] = objectToHandle;
	
			if (matchPercentage < 0.8 && !raw) {
				results.youtube.splice(i, i + 1);
			}
		}
	}

	// POSSIBLE PROBLEM: Array turns into object, and for loop might not continue because of that.
	// POSSIBLE SOLUTION: Add match percentage to all results, then get all indexes that should be removed, and do them all at once.
	return results;
}

function Compare(strA, strB) {
	for (var result = 0, i = strA.length; i--;) {
		if (typeof strB[i] == 'undefined' || strA[i] == strB[i]);
		else if (strA[i].toLowerCase() == strB[i].toLowerCase())
			result++;
		else
			result += 4;
	}
	return 1 - (result + 4 * Math.abs(strA.length - strB.length)) / (2 * (strA.length + strB.length));
}