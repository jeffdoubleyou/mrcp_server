const uuid_v4 = require('uuid').v4
const _ = require('lodash')

const convert = require('pcm-convert')

const GoogleSpeechRecogStream = require('../src/google_speech_recog_stream.js')
const JuliusSpeechRecogStream = require('../src/julius_speech_recog_stream.js')
const OlarisSpeechRecogStream = require('../src/olaris_speech_recog_stream.js')

const config = require('../config/default.js')

function close_speech_recog_streams(self, state) {
    if(!state.sr_streams) return
    for([key, stream] of Object.entries(state.sr_streams)) {
        console.log(`Closing stream ${key}`)
        stream.removeAllListeners()
        stream.end()
        delete state.sr_streams[key]
    }
}

function write_to_streams(self, state, data) {
    //console.dir(data)

    for([key, stream] of Object.entries(state.sr_streams)) {
        stream.write(data.data)
    }
}

function prepare_speech_recog_streams(self, state) {
    close_speech_recog_streams(self, state)

    var streams = {}
    var stream


    stream = new GoogleSpeechRecogStream(uuid_v4(), 'ja-JP', null, {src_encoding: 'l16'})
    streams['google'] = stream

    stream.on('ready', () => {
        self({type: 'sr_ready', engine: 'google'})
    })

    stream.on('data', data => {
        self({type: 'sr_data', engine: 'google', data: data.transcript})
    })

    stream.on('error', err => {
        self({type: 'sr_error', engine: 'google', error: err})
    })
 
    stream.on('close', () => {
        self({type: 'sr_close', engine: 'google'})
    })



    var c = config.olaris
    c.src_encoding = 'l16'
    stream = new OlarisSpeechRecogStream(uuid_v4(), 'ja-JP', null, c)
    streams['olaris'] = stream

    stream.on('ready', () => {
        self({type: 'sr_ready', engine: 'olaris'})
    })

    stream.on('data', data => {
        self({type: 'sr_data', engine: 'olaris', data: data.transcript})
    })

    stream.on('error', err => {
        self({type: 'sr_error', engine: 'olaris', error: err})
    })
 
    stream.on('close', () => {
        self({type: 'sr_close', engine: 'olaris'})
    })


    var c = config.julius
    c.src_encoding = 'l16'
    stream = new JuliusSpeechRecogStream(uuid_v4(), 'ja-JP', null, c)
    streams['julius'] = stream

    stream.on('ready', () => {
        self({type: 'sr_ready', engine: 'julius'})
    })

    stream.on('data', data => {
        self({type: 'sr_data', engine: 'julius', data: data.transcript})
    })

    stream.on('error', err => {
        self({type: 'sr_error', engine: 'julius', error: err})
    })
 
    stream.on('close', () => {
        self({type: 'sr_close', engine: 'julius'})
    })



    state.sr_streams = streams
    state.sr_streams_pending = Object.keys(streams).length

    state.results = {'google': null, 'olaris': null, 'julius': null}
}

module.exports = function (state) {
    var self = function (msg) {
        console.log(`request_actor got ${JSON.stringify(msg)}`)
        switch(msg.type) {
        case 'init':
            state.socket.on('start', function() {
                prepare_speech_recog_streams(self, state)
            })
            state.socket.on('audio', data => {
                //console.log(`state.socket.on audio got ${JSON.stringify(data)}`)
                if(!state.sr_streams || state.sr_streams_pending > 0) return

                write_to_streams(self, state, data)
            })
            console.log("init done")
            break
        case 'sr_ready':
            state.sr_streams_pending--
            if(state.sr_streams_pending == 0) {
                state.socket.emit('started')
            } 
            break
        case "sr_error":
            close_speech_recog_streams(self, state)
            state.socket.emit("error", msg.error)
            break
        case 'sr_data':
            state.results[msg.engine] = msg.data            
            console.dir(state.results)
            if(_.every(state.results, x => x != null)) {
                state.socket.emit('final', state.results)
                close_speech_recog_streams(self, state)
            } else {
                state.socket.emit('partial', state.results)
            }
            break
        case 'stop':
            close_speech_recog_streams(self, state)
            state.socket.emit('stopped')
            break
        case 'terminate':
            close_speech_recog_streams(self, state)
            break
        default:
            console.error(`Unexpected msg: ${JSON.stringify(msg)}`)
        }
    }

    return self
}
