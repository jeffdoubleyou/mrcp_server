const {spawn, dispatch, stop} = require('nact')

const fs = require('fs')

const wav = require('wav')

const logger = require('../logger.js')
const u = require('../utils.js')
const MT = require('../message_types.js')

const config = require('config')

const registrar = require('../registrar.js')

const stream = require('stream')

const stop_myself = (state, ctx) => {
	stop_speak(state)
	stop(ctx.self)
}

const setup_speechsynth = (ctx, uuid, data, state) => {
	const textToSpeech = require('@google-cloud/text-to-speech');
	const fs = require('fs');
	const util = require('util');

	const client = new textToSpeech.TextToSpeechClient();

	const outputFile = `./tmp/${uuid}.l16`

	const request = {
		input: {
			text: data.body,
		},
		voice: {
			languageCode: data.headers['speech-language'],
			name: data.headers['voice-name'],
		},
		audioConfig: {
			audioEncoding: 'LINEAR16',
			sampleRateHertz: 8000,
		}
	}

	console.dir(request)

	client.synthesizeSpeech(request, null, (err, response) => {
		if(state.aborted) return

		if(err) {
			logger.log('error', `synthesizeSpeech error: ${err}`)
			return
		}

		var bufferStream = new stream.PassThrough()

		bufferStream.end(response.audioContent)

		var writeStream = fs.createWriteStream(outputFile)
		var wavReader = new wav.Reader()

		wavReader.on('format', (format) => {
			if(state.aborted) return

			wavReader.pipe(writeStream)	
		})

		writeStream.on('error', (err) => {
			if(state.aborted) return

			if(err) {
				logger.log('error', `Audio content failed to be written to file ${outputFile}. err=${err}`)
				return
			}
		})

		writeStream.on('finish', () => {
			if(state.aborted) return

			logger.log('info', `Audio content written to file: ${outputFile}`)
			dispatch(ctx.self, {type: MT.TTS_FILE_READY, data: data, path: outputFile})

			client.close()
			.then(res => {
				console.log(`TextToSpeechClient closed successfully}`)
			})
			.catch(err => {
				console.log(`TextToSpeechClient closure failed: ${err}`)
			})
		})

		bufferStream.pipe(wavReader)
	})
}

var stop_speak = (state) => {
	if(state.path) {
		fs.unlink(state.path, () => {})
		state.path = null
	}
	if(state.timer_id) {
		clearInterval(state.timer_id)
		state.timer_id = null
	}
	state.aborted = true
}

// Original C code for linear2ulaw by:
//** Craig Reese: IDA/Supercomputing Research Center
//** Joe Campbell: Department of Defense
//** 29 September 1989
// http://www.speech.cs.cmu.edu/comp.speech/Section2/Q2.7.html

const exp_lut = [0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
				 4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
				 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
				 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
				 6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
				 6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
				 6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
				 6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
				 7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7]

const BIAS = 0x84   /* define the add-in bias for 16 bit samples */
const CLIP = 32635

const linear2ulaw = (sample) => {
	var sign, exponent, mantissa
	var ulawbyte

	/* Get the sample into sign-magnitude. */
	sign = (sample >> 8) & 0x80;		/* set aside the sign */
	if (sign != 0) sample = -sample;		/* get magnitude */
	if (sample > CLIP) sample = CLIP;		/* clip the magnitude */

	/* Convert from 16 bit linear to ulaw. */
	sample = sample + BIAS;
	exponent = exp_lut[(sample >> 7) & 0xFF];
	mantissa = (sample >> (exponent + 3)) & 0x0F;
	ulawbyte = ~(sign | (exponent << 4) | mantissa);

/*
//#ifdef ZEROTRAP
*/
	if (ulawbyte == 0) ulawbyte = 0x02;	// optional CCITT trap
/*
//#endif
*/

	return ulawbyte
}

module.exports = (parent, uuid) => spawn(
	parent,
	(state = {}, msg, ctx) => {
		//logger.log('info', `${u.fn(__filename)} got ${JSON.stringify(msg)}`)
		logger.log('info', `${u.fn(__filename)} got ${msg.type}`)
		if(msg.type == MT.START) {
			setup_speechsynth(ctx, uuid, msg.data, state)
			return state
		} else if(msg.type == 'TTS_FILE_READY') {
			if(state.aborted) return

			if(!(uuid in registrar)) return

			state.path = msg.path

			fs.open(msg.path, 'r', (err, fd) => {
				if(state.aborted) return

				if(err) {
					logger.log('error', `Failed to open ${msg.path}`)
					return
				}

				var buf = Buffer.alloc(320)
				var buf2 = Buffer.alloc(160)

				state.timer_id = setInterval(() => {
					if(state.aborted) return

					if(!(uuid in registrar)) {
						stop_speak(state)
						return
					}

					fs.read(fd, buf, 0, 320, null, (err, len) => {
						if(state.aborted) return
						
						if(err) {
							logger.log('error', `Reading ${msg.path} failed with ${err}`)
							stop_speak(state)
							return
						}

						if(!(uuid in registrar)) {
							stop_speak(state)
							return
						}

						var data = registrar[uuid]

						if(len == 0) {
							logger.log('info', `Reading ${msg.path} reached end of file`)
								
							dispatch(parent, {type: MT.MEDIA_OPERATION_COMPLETED, data: msg.data})
							stop_myself(state, ctx)
							return
						}

						for(var i=0 ; i<160 ; i++) {
							// L16 little-endian
							buf2[i] = linear2ulaw((buf[i*2+1] << 8) + buf[i*2])
						}
						
						registrar[uuid].rtp_session.send_payload(buf2)
					})
				}, 19) // ptime=20ms (so we will use 19ms to minimize lag)
			})
			return state
		} else if(msg.type == MT.TERMINATE) {
			stop_myself(state, ctx)
			return
		} else {
			logger.log('error', `${u.fn(__filename)} got unexpected message ${JSON.stringify(msg)}`)
			return state
		}
	}
)