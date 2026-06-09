// RingFrame (machine 4) — spec & layout. Debug THIS machine here.
window.MACHINE_CONFIG = window.MACHINE_CONFIG || {};
window.MACHINE_DEFS   = window.MACHINE_DEFS   || {};

window.MACHINE_CONFIG[4] = {name:'RingFrame', sub:'CAN4 · 192.168.1.125:4001',                                              can:'CAN4',port:4001};

window.MACHINE_DEFS[4] = { // RingFrame (placeholder)
    addrMap:{0x01:'MB',0x02:'FR',0x03:'BR',0x04:'CREEL'},
    motorMap:{0x02:'fr',0x03:'br',0x04:'cr'},
    motorNames:{fr:'Front Roller',br:'Back Roller',cr:'Creel'},
    setupLabels:{fr:'Front Roller',br:'Back Roller',cr:'Creel'},
    fnMap:{0x01:'MotorState',0x02:'Error',0x07:'RunSetup',0x09:'RuntimeData',0x0F:'ACK'},
    hasAL:false, hasLifts:false, errorBytes:2,
  };
