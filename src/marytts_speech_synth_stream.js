require('magic-globals')

const WaveFile = require('wavefile').WaveFile;
const MaryTTS = require('marytts')

const logger = require('./logger.js')
const u = require('./utils.js')

const { Readable } = require('stream')

const { EventEmitter } = require('events')

const FILE = u.filename()

const log = (line, level, entity, msg) => {
    logger.log(level, entity, `(${FILE}:${line}) ${msg}`)
}

class MaryTTSGenerationStream extends Readable {
    constructor(uuid, data, language, config) {
        super()
        this.uuid = uuid
        this.eventEmitter = new EventEmitter()
        this.marytts = MaryTTS(config.marytts.server_ip, config.marytts.server_port);
        this.voice = data.headers['voice-name'] ? data.headers['voice-name'] : config.marytts.default_voice
            this.setup_speechsynth(data)
    }

    setup_speechsynth(data) {
        log(__line, 'info', this.uuid, `MaryTTS request to pronounce speech for: ${data.body}`)
        this.offset = 0
        const _this = this

        this.marytts.process(data.body, {base64: false, outputType: 'audio', inputType: 'text', audio: 'wave_file', voice: this.voice}, function(audio) {
            log(__line, 'info', _this.uuid, `MaryTTS speech request processed`)
            let wave = new WaveFile(audio);
            wave.toSampleRate(8000)
            _this.wavBuffer = wave.toBuffer()
            _this.eventEmitter.emit('ready')
        })
    }

    on(evt, cb) {
        super.on(evt, cb)
        this.eventEmitter.on(evt, cb)
    }

    _read(size) {
        let buf = Buffer.alloc(size/2)
        for(let i=0; i<size/2; i++) {
            buf[i] = u.linear2ulaw((this.wavBuffer[(this.offset+i)*2+1] << 8) + this.wavBuffer[i*2])
        }
        this.offset += size/2
        this.push(buf)
    }
}

module.exports = MaryTTSGenerationStream
