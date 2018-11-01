

module.exports = function(RED) {
	var co = require('node-direct-canopen');

	/* Configure the TX PDO 0 for max 64 digital inputs */
	/* Configure the RX PDO 0 for max 64 digital outputs */
	function wago_configure_pdo0(con, nb_bl_in, nb_bl_out){
		var promises = [
			/* --------------- RX PDO 0 --------------- */		
			/* Invalid COB - disable PDO 0 */
			con.sdo_download_uint32(0x1400, 1, 0x80000000),
			/* Transfer type */
			con.sdo_download_uint8 (0x1400, 2, 255),
			/* Number of mapped object for PDO 0 */
			con.sdo_download_uint8 (0x1600, 0,   0),
			/* --------------- TX PDO 0 --------------- */	
			/* Invalid COB - disable PDO 0 */
			con.sdo_download_uint32(0x1800, 1, 0x80000000),
			/* Transfer type */
			con.sdo_download_uint8 (0x1800, 2, 255),
			/* Inhibit Time (x100us) */
			con.sdo_download_uint16(0x1800, 3, 100),
			/* Event Timer (x1ms) */
			con.sdo_download_uint16(0x1800, 5,   0),
			/* Global intterrupt enable digital */
			con.sdo_download_uint8 (0x6005, 0,   1),
			/* Number of mapped object for PDO 0 */
			con.sdo_download_uint8 (0x1A00, 0,   0)
		];
		for(var i=1; i<=nb_bl_out; ++i)	promises.push(
			/* --------------- RX PDO 0 --------------- */	
			/* Mapped object */
			con.sdo_download_uint32(0x1600, i, 0x62000008+0x100*i),
			/* Error Mode Digital Output 8-Bit Block */
			con.sdo_download_uint8 (0x6206, i, 0xFF),
			/* Error Value Digital Output 8-Bit Block */
			con.sdo_download_uint8 (0x6207, i, 0xFF)
		);
		for(var i=1; i<=nb_bl_in; ++i) promises.push(
			/* --------------- TX PDO 0 --------------- */	
			/* Mapped object */
			con.sdo_download_uint32(0x1A00, i, 0x60000008+0x100*i),
			/* Digital Interrupt Mask Any Change Block */
			con.sdo_download_uint8 (0x6006, i, 0xFF)
		);
		promises.push(
			/* --------------- RX PDO 0 --------------- */
			/* Number of mapped object for PDO 0 */
			con.sdo_download_uint8 (0x1600, 0, nb_bl_out),
			/* Valid COB - enable PDO 0 */
			con.sdo_download_uint32(0x1400, 1, 0x200+con.node_id),
			/* --------------- TX PDO 0 --------------- */	
			/* Number of mapped object for PDO 0 */
			con.sdo_download_uint8 (0x1A00, 0,   nb_bl_in),
			/* Valid COB - enable PDO 0 */
			con.sdo_download_uint32(0x1800, 1, 0x180+con.node_id)
		);
		return Promise.all(promises);
	}

	function wago_hanlde_pdo0(node){
		/* Receive a PDO and then send a message */
		node.con.pdo_recv(function(pdoid, data){
			var b = new Uint8Array(data);
			var o = new Uint8Array(node.cache_in);
			var l = Math.min(b.length, o.length);
			for(var i=0;i<l;++i){
				var c = b[i] ^ o[i];
				if(c == 0) continue;
				for(var j=0;j<8;j++){
					var m = 1<<j;
					if(c & m) node.send({
						index: j+8*i,
						payload: (b[i] & m) ? "on":"off" 
					});
				}
			}
			node.cache_in = data;
		});

		/* Receive a message and then send a PDO */
		node.on('input', function(msg) {
			if(msg.index == null) msg.index = 0;
			var b = new Uint8Array(node.cache_out);
			var i = Math.floor(msg.index/8);
			var m = 1<<(msg.index%8);
			switch(msg.payload){
				case "toggle":
					if(b[i] & m) b[i] &= ~m;
					else b[i] |=  m;
					break;
				case "on":
					b[i] |=  m;
					break;
				case "off":
					b[i] &= ~m;
					break;
			}
			node.con.pdo_send(0, node.cache_out);
		});
	}

	function wago_hearbeat(node, state){
		if(state instanceof Error){
			node.status({fill:"red",shape:"ring",text:"Disconnected"});
		}else if(state == co.HB_PRE_OPERATIONAL){
			Promise.all([
				node.con.sdo_upload_uint8(0x6000, 0),
				node.con.sdo_upload_uint8(0x6200, 0)
			]).then(res => {
				node.cache_in = new ArrayBuffer(res[0]);
				node.cache_out = new ArrayBuffer(res[1]);
				var info = "DI: "+res[0]*8+" / DO: "+res[1]*8;
				node.status({fill:"green",shape:"ring",text:info});
				wago_configure_pdo0(node.con, res[0], res[1]).then(test => {
					wago_hanlde_pdo0(node);
					node.con.nmt_send(co.NMT_OPERATIONAL);
				}).catch(err => {
					node.status({fill:"red",shape:"ring",text:"Configure PDO: "+err});
				});
			},err => {
				node.status({fill:"red",shape:"ring",text:"Get IO: "+err});
			});
		}
	}

	function WAGO33XNode(config) {
		RED.nodes.createNode(this, config);		
		var node = this;
		node.canDev  = config.canDev;
		node.canId  = parseInt(config.canId);
		node.con = co.create_node(node.canDev, node.canId);

		/* Reset */
		node.con.nmt_send(co.NMT_RESET_NODE);

		/* Check status every 5 seconds */
		node.con.heartbeat(state => wago_hearbeat(node, state));
		node.refresh_timer = setInterval(node.con.heartbeat, 5000);

		/* Close the timer and node on exit */
		node.on("close", function() {
			clearInterval(node.refresh_timer);
			node.con.stop();
		});
	}

	RED.nodes.registerType("wago33x", WAGO33XNode);
}

