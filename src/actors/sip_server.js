const {spawn, dispatch} = require('nact')

const sip = require('sip')
const uuid_v4 = require('uuid').v4
const Deque = require('collections/deque')

const logger = require('../logger.js')
const u = require('../utils.js')
const MT = require('../message_types.js')

const dm = require('data-matching')

const registrar = require('../registrar.js')

const config = require('config')

const sdp_matcher = dm.partial_match({
	connection: { ip: dm.collect('rtp_ip') },
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
			port: dm.collect('rtp_port'),
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
	logger.log('info', 'process_incoming_call')

	var rtp_port = state.rtp_ports.shift()
	if(!rtp_port) {
		state.sip_stack.send(sip.makeResponse(req, 500, 'No RTP port available'))
		return
	}

	var data = {
		uuid: req.headers['call-id'],
		local_rtp_port: rtp_port,
	}

	var offer_sdp = u.parse_sdp(req.content)

	logger.log('info', "p2")

	if(!sdp_matcher(offer_sdp, data)) {
		state.sip_stack.send(sip.makeResponse(req, 400, 'Invalid SDP'))
		return
	}

	logger.log('info', "p3")

	dispatch(state.mrcp_server, {type: MT.REQUEST_CREATED, data: data})

	logger.log('info', "p4")

	var answer_sdp = gen_sdp(config.local_ip_address, config.mrcp_port, rtp_port, data.connection, data.uuid, data.resource)

	logger.log('info', "p5")

	var res = sip.makeResponse(req, 200, 'OK')
	logger.log('info', "p6")

	res.headers.to.params.tag = rstring()

	logger.log('info', "p7")
	res.headers['record-route'] = req.headers['record-route']
	logger.log('info', "p8")
	res.headers.contact = [{uri: `sip:mrcp_server@${config.local_ip_address}:${config.sip_port}`}]
	logger.log('info', "p9")
	res.headers['content-type'] = 'application/sdp'
	logger.log('info', "p10")
	res.content = answer_sdp
	logger.log('info', "p11")

	logger.log('info', `Sending res`)
	state.sip_stack.send(res,
		function(res) {
			logger.log('info', "got callback to res sent to out-of-dialog INVITE on sip stack")
		}
	)

	logger.log('info', "p12")
	registrar[data.uuid] = data
	logger.log('info', "p13")
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

		dispatch(state.mrcp_server, {type: MT.REQUEST_TERMINATED, uuid: uuid})

		logger.log('info', `BYE call_id=${uiid}`)
		if(registrar[uuid]) {
			var port = registrar[uuid].local_rtp_port
			delete registrar[uuid]
			state.rtp_ports.push(port)
		}
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
			ui.destroy()
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
		if(msg.type == MT.START) {
			state.rtp_ports = new Deque()
			for(var i=config.rtp_lo_port ; i<=config.rtp_hi_port ; i=i+2) {
				state.rtp_ports.push(i);
			}
			state.sip_stack = create_sip_stack(state)
			state.mrcp_server = msg.data.mrcp_server
			return state
		} else {
			logger.log('error', `${u.fn(__filename)} got unexpected message ${JSON.stringify(msg)}`)
			return state
		}
	},
	'sip_server'
)
