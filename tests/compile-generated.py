#!/usr/bin/env python3
"""Compile a normalized multi-board release against a minimal AIDC ABI fixture."""
import pathlib, tempfile, zipfile, subprocess, xml.etree.ElementTree as E
root=pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='protocol-topology-c-') as directory:
    out=pathlib.Path(directory)
    with zipfile.ZipFile(root/'.runtime/test-release.zip') as z:z.extractall(out)
    board=out/'boards/ARM_1'
    contract=r'''
#ifndef CONTRACT_H
#define CONTRACT_H
#include <stdint.h>
#include <stddef.h>
#include <assert.h>
typedef void VOID;typedef uint8_t UINT8;typedef uint16_t UINT16;typedef uint32_t UINT32;typedef int32_t INT32;typedef int16_t INT16;typedef float FLOAT;typedef int BOOLEAN;
#define FALSE 0
#define TRUE 1
#define MPP_RET_OK 0
#define MPP_RET_ERR -1
#define CAN_PORT1 10
#define UPP_MODE_R 1
#define UPP_MODE_W 2
#define UPP_MODE_RW 3
#define UPP_CFG_MOD_DATAID 1
#define PRO_DATA_PROCESS 1
#define PRO_UPP_MASTER 2
#define PRO_MB_MASTER 3
#define PRO_MB_SLAVE 4
#define PRO_UPP_SLAVE 5
#define PRO_ADDR_SLAVE 6
typedef enum{DATA_TYPE_U8,DATA_TYPE_U16,DATA_TYPE_S16,DATA_TYPE_U32,DATA_TYPE_S32,DATA_TYPE_FLOAT,DATA_TYPE_STRING} DATA_TYPE_E;
#define UPP_DATA_TYPE_U16 DATA_TYPE_U16
#define UPP_DATA_TYPE_U32 DATA_TYPE_U32
#define UPP_DATA_TYPE_STRING DATA_TYPE_STRING
#define UPP_DATA_TYPE_FLOAT DATA_TYPE_FLOAT
typedef union{UINT8 u8;UINT16 u16;INT16 s16;UINT32 u32;INT32 s32;FLOAT f32;VOID *pst;}DATA_U;
typedef struct{DATA_U def_value,min_value,max_value;}DM_SIG_DATA_S;
typedef struct{UINT16 sig_id;UINT8 sig_size,sig_flag;UINT32 data_type;void *pf_sig_proc;}DM_SIG_CFG_S;
typedef struct{UINT16 mod_data_offset,mod_data_len,mod_data_type,data_len;UINT32 sig_id;UINT16 data_type;UINT8 rw_mode,byte_order,set_pri,scan_pri,rqst_cyl;double dec_p;}UPP_M_MOD_DATA;
typedef struct{UPP_M_MOD_DATA *p_data;UINT16 data_num,mod_id;}UPP_M_MOD;
typedef struct{UPP_M_MOD *p_model_ary;UINT16 model_num,cfg_mode;}UPP_M_MOD_REG;
typedef struct{UINT16 proto_type,sig_num;VOID *pst_table;}DEV_TBL_CFG_S;
typedef struct{UINT8 dev_id,port,coll_addr;UINT16 dev_code;DEV_TBL_CFG_S ptl_tbl_cfg[7];}DEV_TABLE_S;
typedef struct{UINT16 sig_id,reg_addr;UINT8 reg_num,dev_id,reg_type,byte_order;}MB_TABLE_CELL_T;
typedef struct{int unused;}MB_PKT_DATA_T;
typedef struct{UINT16 reg_addr,end_addr;INT32(*func)(UINT16,MB_PKT_DATA_T*,UINT8*,UINT16*);}MB_TABLE_SEG_T;
static unsigned restores;
static int32_t set_dp_para_value(UINT16 dev,UINT16 sig,UINT16 size,UINT8 *value){
 assert(dev==11);if(sig==2502){assert(size==4);assert(*(UINT32*)value==10);}else{assert(sig==2503&&size==8);assert(value[0]=='O'&&value[1]=='K'&&value[2]==0&&value[7]==0);}restores++;return 0;
}
#endif
'''
    (board/'contract.h').write_text(contract)
    for h in ['data_process.h','arc_public.h','globalfunction.h','local_equip.h','dev_cfg.h','pub_sig_def.h','collect_lib.h','upp_m_ex.h','upp_public_ex.h','port.h','transmit_lib.h','upp_s_perf.h','upp_s_cfg.h']:
        (board/h).write_text('#include "contract.h"\n')
    (board/'test.c').write_text(r'''
#include "dev_cfg.c"
#include "signal_range.c"
INT32 upp_passthrough_dsp1_callback(UINT16 a,MB_PKT_DATA_T*b,UINT8*c,UINT16*d){(void)a;(void)b;(void)c;(void)d;return 0;}
int main(void){
 assert(cfg_dev_num()==2);
 const DEV_TABLE_S *dev=cfg_get_dev_table();assert(dev[0].dev_id==11&&dev[0].coll_addr==1&&dev[0].port==CAN_PORT1);
 assert(dev[0].ptl_tbl_cfg[0].sig_num==3);
 const UPP_M_MOD_REG *upp=dev[0].ptl_tbl_cfg[1].pst_table;assert(upp->model_num==1);assert(upp->p_model_ary[0].data_num==3);
 const UPP_M_MOD_DATA *f=upp->p_model_ary[0].p_data;assert(f[0].sig_id==2502&&f[0].mod_data_len==4&&f[0].dec_p==0.1);assert(f[1].mod_data_offset==10&&f[1].sig_id==30000);assert(f[2].data_type==UPP_DATA_TYPE_FLOAT&&f[2].sig_id==2504);
 assert(dev[1].ptl_tbl_cfg[0].proto_type==PRO_MB_SLAVE&&dev[1].ptl_tbl_cfg[0].sig_num==2);
 const MB_TABLE_CELL_T *mb=dev[1].ptl_tbl_cfg[0].pst_table;assert(mb[0].sig_id==2502&&mb[1].sig_id==2502);assert(mb[0].reg_num==2);
 assert(g_protocol_segments[0].reg_addr==50000&&g_protocol_segments[0].end_addr==50999);
 DM_SIG_DATA_S v;BOOLEAN recover;signal_range_init();assert(signal_range_get(11,2502,&v,&recover)==0);assert(v.def_value.u32==10&&!recover);assert(signal_range_get(11,2503,&v,&recover)==0);assert(recover&&((UINT8*)v.def_value.pst)[7]==0);
 assert(signal_range_get(11,2504,&v,&recover)==0&&v.def_value.f32==1.5f);assert(signal_range_restore_default()==0&&restores==2);return 0;
}
''')
    subprocess.run(['gcc','-std=c11','-Wall','-Wextra','-Werror','-I'+str(board),str(board/'test.c'),'-o',str(board/'test')],check=True)
    subprocess.run([str(board/'test')],check=True)
    xml=E.parse(out/'boards/DSP_1/SERVE.xml').getroot()
    assert xml.find('protocol').get('DevCode')=='1'
    points=xml.findall('./protocol/model/point');assert len(points)==3 and points[1].get('OffsetAddr')=='10'
print('PASS: generated board C compiles with -Werror; registration, independent IDs, aliases, shifted layouts, precision, padded strings and distinct restore policies verified.')
