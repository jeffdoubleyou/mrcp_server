const {spawn, dispatch} = require('nact')

const sip = require('sip')
//const udp = require('dgram')
const uuid_v4 = require('uuid').v4
const Deque = require('collections/deque')
const _ = require('lodash')

const logger = require('../logger.js')
const u = require('../utils.js')
const MT = require('../message_types.js')

const dm = require('data-matching')

const registrar = require('../registrar.js')

const config = require('config')

const sdp_matcher = dm.partial_match({
	connection: { ip: dm.collect('remote_rtp_ip') },
	media: dm.unordered_list([
		{
			type: 'application',
			port: 9,
			protocol: 'TCP/MRCPv2',
			payloads: ["1"],
			resource: dm.any_of(['speechsynth', 'speechrecog'], 'resource'),
			connection: dm.collect('connection'),
		},
		{
			type: 'audio',
			port: dm.collect('remote_rtp_port'),
			protocol: 'RTP/AVP',
			payloads: dm.collect("rtp_payloads"),
		}
	])
})

var gen_sdp = (local_ip, mrcp_port, rtp_port, connection, uuid, resource) => {
	return 'v=0\r\n' +
	`o=mrcp_server 1212606071011504954 4868540303632141964 IN IP4 ${local_ip}\r\n` +
	"s=-\r\n" +
	`c=IN IP4 ${local_ip}\r\n` +
	't=0 0\r\n' +
	`m=application ${mrcp_port} TCP/MRCPv2 1\r\n` +
	'a=setup:passive\r\n' +
	`a=connection:${connection}\r\n` +
	`a=channel:${uuid}@${resource}\r\n` +
	'a=cmid:1\r\n' +
	`m=audio ${rtp_port} RTP/AVP 0\r\n` +
	'a=rtpmap:0 PCMU/8000\r\n' +
	`a=${resource == 'speechsynth' ? 'sendonly' : 'recvonly'}\r\n` +
	'a=mid:1\r\n'
}

var rstring = () => {
	return Math.floor(Math.random()*1e6).toString()
};

var process_incoming_call = (state, req) => {
	const uuid = req.headers['call-id']

	logger.log('info', `process_incoming_call: ${uuid}`)

	var rtp_session_index = state.free_rtp_sessions.shift()

	if(rtp_session_index == undefined) {
        var rs = 500
        var rr = 'No RTP port available'
		state.sip_stack.send(sip.makeResponse(req, rs, rr))
		logger.log('info', `Refused call ${uuid}: ${rs} ${rr}`)
		return
	}

	if(!req.content || req.content == '') {
        var rs = 400
        var rr = 'No SDP (Delayed Media Not Acceptable)'
		state.sip_stack.send(sip.makeResponse(req, rs, rr))
		logger.log('info', `Refused call ${uuid}: ${rs} ${rr}`)
		return
    }

	var data = {
		uuid: uuid,
		sip_req: req,
	}

	var offer_sdp = u.parse_sdp(req.content)

	if(!sdp_matcher(offer_sdp, data)) {
        var rs = 400
        var rr = 'Invalid SDP for Speech Service'
		state.sip_stack.send(sip.makeResponse(req, rs, rr))
		logger.log('info', `Refused call ${uuid}: ${rs} ${rr}`)
		return
	}
 
	if(!data.rtp_payloads.includes("0")) {
        // We currently only accept G.711 PCMU (payload_type=0)
        var rs = 415
        var rr = 'Unsupported Media Type'
		state.sip_stack.send(sip.makeResponse(req, rs, rr))
		logger.log('info', `Refused call ${uuid}: ${rs} ${rr}`)
		return
	}

    var rtp_session = state.rtp_sessions[rtp_session_index]

    rtp_session.setup({
        remote_ip: data.remote_rtp_ip,
        remote_port: data.remote_rtp_port,
        payload_type: 0,
        ssrc: u.gen_random_int(0xffffffff),
    })

    data.local_ip = rtp_session.local_ip
    data.local_port = rtp_session.local_port
	data.rtp_session = rtp_session

	dispatch(state.mrcp_server, {type: MT.SESSION_CREATED, data: data})

	var answer_sdp = gen_sdp(config.local_ip, config.mrcp_port, rtp_session.local_port, data.connection, data.uuid, data.resource)

	var res = sip.makeResponse(req, 200, 'OK')

	res.headers.to.params.tag = rstring()

	res.headers['record-route'] = req.headers['record-route']
	res.headers.contact = [{uri: `sip:mrcp_server@${config.local_ip}:${config.sip_port}`}]
	res.headers['content-type'] = 'application/sdp'
	res.content = answer_sdp

	data.sip_res = res

	state.sip_stack.send(res,
		function(res) {
			logger.log('info', "got callback to res sent to out-of-dialog INVITE on sip stack")
		}
	)

	registrar[data.uuid] = data
}

var process_in_dialog_request = (state, req) => {
	if(req.method == 'ACK'){
		// nothing to do
		return
	}

	if(req.method != 'INVITE' && req.method != 'BYE') {
		logger.log('info', `Unexpected in-dialog ${req.method}. Sending default '200 OK' reply`)
		state.sip_stack.send(sip.makeResponse(req, 200, 'OK'))
		return
	}

	if(req.method == 'BYE') {
		var res = sip.makeResponse(req, 200, 'OK')
		state.sip_stack.send(res)

		var uuid = req.headers['call-id']

        var call = registrar[uuid]

        if(call) {
		    dispatch(state.mrcp_server, {type: MT.SESSION_TERMINATED, uuid: uuid, handler: call.handler})
        }

		logger.log('info', `BYE call_id=${uuid}`)
		state.free_rtp_sessions.push(call.rtp_session._id)
        delete registrar[uuid]
		return
	}

	logger.log('error', "REINVITE SUPPORT IMPLEMENTATION PENDING")
	process.exit(1)
}

function create_sip_stack(state) {
	var sip_stack = sip.create({
		address: config.local_ip,
		port: config.sip_port,
		publicAddress: config.local_ip,
	},
	function(req) {
		try {
			logger.log('info', `Incoming request ${req.method}`);
			var to_tag = req.headers['to'].params.tag

			if(!to_tag && req.method != 'INVITE') {
				var res = sip.makeResponse(req, 200, 'OK')
				state.sip_stack.send(res)
				return
			}

			if(to_tag) {
				process_in_dialog_request(state, req)
				return
			}

			process_incoming_call(state, req);
		} catch(err) {
			console.log(err)
			process.exit(100)
		}
	})
	return sip_stack
}


module.exports = (parent) => spawn(
	parent,
	(state = {}, msg, ctx) => {
		//logger.log('info', `${u.fn(__filename)} got ${JSON.stringify(msg)}`)
		logger.log('info', `${u.fn(__filename)} got ${msg.type}`)

		if(msg.type == MT.START) {
            state.mrcp_server = msg.data.mrcp_server

            var udp_ports = _.range(config.rtp_lo_port, config.rtp_hi_port, 2)

            state.free_rtp_sessions = new Deque()
            for(var i=0 ; i<udp_ports.length ; i++) {
                state.free_rtp_sessions.push(i)
            }

            u.alloc_rtp_sessions(udp_ports, config.local_ip)
            .then(rtp_sessions => {
				dispatch(ctx.self, {type: MT.PROCEED, data: {rtp_sessions: rtp_sessions}})
            })
            .catch(err => {
                console.error("CRITICAL: could not allocate RTP range. Terminating")
                process.exit(1)
            })
            return state
        } else if(msg.type == MT.PROCEED) { 
            state.rtp_sessions = msg.data.rtp_sessions

			state.sip_stack = create_sip_stack(state)

			state.rtpCheckTimer = setInterval(() => {
				var now = Date.now()
				Object.keys(registrar).forEach(uuid => {
					var call = registrar[uuid]
					if(now - call.rtp_session.activity_ts > config.rtp_timeout) {
						logger.log('warning', `Sending BYE to call_id=${uuid} due to RTP inactivity`)

						//var port = registrar[uuid].local_rtp_port
						//call.rtp_session.close()
						//state.free_rtp_sessions.push(port)
						state.free_rtp_sessions.push(call.rtp_session._id)

						dispatch(state.mrcp_server, {type: MT.SESSION_TERMINATED, uuid: uuid, handler: call.handler})

                        delete registrar[uuid]

						state.sip_stack.send({
							method: 'BYE',
							uri: call.sip_req.headers.contact ? call.sip_req.headers.contact[0].uri : call.sip_req.headers.from.uri,
							headers: {
								to: call.sip_res.headers.from,
								from: call.sip_res.headers.to,
								'call-id': call.sip_req.headers['call-id'],
								cseq: {method: 'BYE', seq: call.sip_req.headers.cseq.seq + 1},
								via: []
							}
						}, (res) => {
								console.log(`BYE for call ${uuid} got: ${res.status} ${res.reason}`)	
						})
					}
				})
			}, 1000)

			return state
		} else {
			logger.log('error', `${u.fn(__filename)} got unexpected message ${JSON.stringify(msg)}`)
			return state
		}
	},
	'sip_server'
)
