const path = require('path')
const assert = require('assert')

function parse_sdp(s) {
	var sdp = {
		media: []
	}
	var lines = s.split("\r\n")
	var media_id = -1
	lines.forEach(line => {
		var key = line.slice(0,1)
		var val = line.slice(2)

		switch(key) {
		case 'c':
			var c = val.split(" ")
			assert(c.length == 3)			
			sdp.connection = {
				ip: c[2]
			}
			break
		case 'm':
			var m = val.split(" ")
			assert(m.length >= 4)
			media_id++
			sdp.media[media_id] = {
				type: m[0],
				port: parseInt(m[1]),
				protocol: m[2],
				payloads: m.slice(3),
			}
			break
		case 'a':
			var a = val.split(":")
			var k = a[0]
			var v = a[1]
			switch (k) {
			case 'resource':
				sdp.media[media_id].resource = v
				break
			case 'setup':
				sdp.media[media_id].setup = v
				break
			case 'connection':
				sdp.media[media_id].connection = v
				break
			case 'direction':
				sdp.media[media_id].direction = v
				break
			}
		}
	})
	return sdp
}

module.exports = {
	parse_sdp: parse_sdp,

	fn: (filepath) => {
		return path.basename(filepath)
	},
}

