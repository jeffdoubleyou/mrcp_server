require('magic-globals')
const {spawn, dispatch, stop} = require('nact')
const mrcp = require('mrcp')

const fs = require('fs')

const xml = require('xml-js')

const logger = require('../logger.js')
const u = require('../utils.js')
const MT = require('../message_types.js')

const config = require('config')

const DtmfSpeechSynthStream = require('../dtmf_speech_synth_stream.js')
const MorseSpeechSynthStream = require('../morse_speech_synth_stream.js')
const GoogleSpeechSynthStream = require('../google_speech_synth_stream.js')
const MaryTTSSpeechSynthStream = require('../marytts_speech_synth_stream.js')

const registrar = require('../registrar.js')

const FILE = u.filename()

const log = (line, level, entity,msg) => {
    logger.log(level, entity, `(${FILE}:${line}) ${msg}`)
}

const clearRtpTimer = (state) => {
    if(state.timer_id) {
        clearInterval(state.timer_id)
        state.timer_id = null
    }
}

const stop_myself = (state, ctx) => {
    log(__line, 'info', state.uuid, 'stop_myself')

    clearRtpTimer(state)

    state.aborted = true
    stop(ctx.self)
}

const send_in_progress = (state, uuid, req_id, msg) => {
    const rs = 200
    const rr = 'IN-PROGRESS'
    const headers = {'channel-identifier': msg.data.headers['channel-identifier']}
    log(__line, 'info', uuid, `sending MRCP response ${req_id} ${rs} ${rr} ${JSON.stringify(headers)}`)
    const response = mrcp.builder.build_response(req_id, rs, rr, headers)
    u.safe_write(state.conn, response)
}

const send_speak_complete = (state, uuid, msg, cause) => {
    if(!cause) {
        cause = '000 normal'
    }

    var req_id = msg.data.request_id
    var evt = 'SPEAK-COMPLETE'
    var req_state = 'COMPLETE'
    var headers = {'channel-identifier': msg.data.headers['channel-identifier'], 'Completion-Cause': cause}
    log(__line, 'info', uuid, `sending MRCP event ${evt} ${req_id} ${req_state}, ${JSON.stringify(headers)}`)
    var event = mrcp.builder.build_event(evt, req_id, req_state, headers)
    u.safe_write(state.conn, event)
}

const send_stop_reply = (uuid, req_id, msg) => {
    var rs = 200
    var rr = 'COMPLETE'
    var headers =  {'channel-identifier': msg.data.headers['channel-identifier']}
    log(__line, 'info', uuid, `sending MRCP response ${req_id} ${rs} ${rr} ${JSON.stringify(headers)}`)
    var response = mrcp.builder.build_response(req_id, rr, rs, headers)
    u.safe_write(msg.conn, response)
}

const startRtpTimer = (state, uuid) => {
    state.timer_id = setInterval(() => {
        if(state.aborted) {
            log(__line, 'info', uuid, `rtpTimer state.aborted=${state.aborted}`)
            return
        }

        if(!registrar.hasOwnProperty(uuid)) {
            log(__line, 'info', uuid, `rtpTimer registrar.hasOwnProperty=${registrar.hasOwnProperty(uuid)}`)
            return
        }

        var buf = state.stream.read(160)
        if(!buf) {
            log(__line, 'info', uuid, `rtpTimer not buf ${buf}`)
            return
        }

        registrar[uuid].rtp_session.send_payload(buf)
        //log(__line, 'info', uuid, `rtpTimer sent buf=${buf.length}`)
    }, 19) // ptime=20ms (so we will use 19ms to minimize lag)
}

module.exports = (parent, uuid) => spawn(
    parent,
    (state = {}, msg, ctx) => {
        //log(__line, 'info', uuid, `got ${JSON.stringify(msg)}`)
        log(__line, 'info', uuid, `got ${msg.type}`)
        if(msg.type == MT.START) {
            return state
        } else if(msg.type == MT.MRCP_MESSAGE) {
            const uuid = msg.data.uuid
            const req_id = msg.data.request_id

            log(__line, 'info', uuid, `got MRCP message ${JSON.stringify(msg.data)}`)
            if(msg.data.method == 'SPEAK') {
                state.conn = msg.conn

                var content
                if(msg.data.headers['content-type'] == 'application/ssml+xml') {
                    try {
                        content = xml.xml2js(msg.data.body)
                    } catch (err) {
                        log(__line, 'info', uuid, `xml parsing error ${err}`)

                        var cause = '002 parse-failure'

                        send_speak_complete(state, uuid, msg, cause)

                        state.ready = false
                        return state
                    }
                    if(!content.elements || !content.elements[0] || !content.elements[0].type == 'element' || !content.elements[0].name == 'speak') {
                        log(__line, 'info', uuid, `Not valid SSML`)

                        var cause = '002 parse-failure'

                        send_speak_complete(state, uuid, msg, cause)

                        state.ready = false
                        return state
                    }
                    content = content.elements[0].elements
                } else {
                    content = msg.data.body
                }

                var language = msg.data.headers['speech-language']

                if(language == 'dtmf') {
                    state.stream = new DtmfSpeechSynthStream(uuid, msg.data, content)
                } else if(language == 'morse') {
                    state.stream = new MorseSpeechSynthStream(uuid, msg.data, content)
                } else {
                    const engine = msg.data.headers['engine'] ? msg.data.headers['engine'] : config.default_ss_engine
                    if(config.default_ss_engine === 'marytts') {
                        state.stream = new MaryTTSSpeechSynthStream(uuid, msg.data, language, config)
                    } else {
                        state.stream = new GoogleSpeechSynthStream(uuid, msg.data)
                    }
                }

                state.stream.on('ready', () => {
                    log(__line, 'info', uuid, `Stream ready`)

                    send_in_progress(state, uuid, req_id, msg)

                    startRtpTimer(state, uuid)

                    state.ready = true
                })

                state.stream.on('error', err => {
                    log(__line, 'info', uuid, `Stream error ${err}`)

                    var cause = '004 error'

                    console.log(err)
                    if(typeof err == 'string' && err.startsWith("parse-failure")) {
                        cause = '002 parse-failure'
                    }

                    send_speak_complete(state, uuid, msg, cause)

                    state.ready = false
                })

                state.stream.on('end', () => {
                    log(__line, 'info', uuid, `Stream end`)

                    const cause = '000 normal'
                    send_speak_complete(state, uuid, msg, cause)

                    clearRtpTimer(state)

                    state.ready = false
                })
            } else if(msg.data.method == 'STOP') {
                clearRtpTimer(state)

                send_stop_reply(uuid, req_id, msg)

                // I believe stop command will not terminate the MRCP session. It will just stop the current SPEAK operation.
                // so we don't stop the actor here.
                //stop_myself(state, ctx)
            }
            return state
        } else if(msg.type == MT.TERMINATE) {
            stop_myself(state, ctx)
            return
        } else {
            log(__line, 'error', uuid, `got unexpected message ${JSON.stringify(msg)}`)
            return state
        }
    }
)
