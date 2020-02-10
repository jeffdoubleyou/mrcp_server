const utils = require('../../src/utils.js')
const dm = require('data-matching')

test('parse_sdp', () => {
	var s = `v=0o=FreeSWITCH 5772550679930491611 4608916746797952899 IN IP4 192.168.1.10
s=-
c=IN IP4 192.168.1.10
t=0 0
m=application 9 TCP/MRCPv2 1
a=setup:active
a=connection:new
a=resource:speechsynth
a=cmid:1
m=audio 14238 RTP/AVP 0 8 96
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:96 L16/8000
a=recvonly
a=mid:1`;


    s = s.replace(/\n/g, "\r\n")

    var sdp = utils.parse_sdp(s)
    console.log("sdp:")
    console.dir(sdp)

    var expected = {
        connection: { ip: dm.collect('ip') },
        media: [
            {
                type: dm.collect('type'),
                port: 9,
                protocol: 'TCP/MRCPv2',
                payloads: ["1"],
                setup: 'active',
                connection: 'new',
                resource: dm.any_of(['speechsynth', 'speechrecog'], 'resource'),
            },
            {
                type: 'audio',
                port: dm.collect('rtp_port'),
                protocol: dm.collect('protocol'),
                payloads: ["0", dm.collect("second_payload"), "96"],
            }
        ],
    }

    console.log("expected:")
    console.dir(expected)

    var matcher = dm.full_match(expected)

	var store = {}
	var res = matcher(sdp, store, true)
	console.log(`res=${res}`)

	expect(res).toBeTruthy()
	expect(store.ip).toBe('192.168.1.10')

	expect(store.type).toBe('application')
	expect(store.rtp_port).toBe(14238)
	expect(store.protocol).toBe("RTP/AVP")
	expect(store.second_payload).toBe("8")
	expect(store.resource).toBe('speechsynth')
})
