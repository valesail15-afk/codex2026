window.$ = jQuery;

// 查找 值在数组中的索引
function in_array(v, a, i) {
	for (i=0; i<a.length; i++) {
		if (v == a[i]) {
			return i;
		}
	}
	return -1;
}

// strtotime('2011-01-01 00:00:00')
// return int unix时间戳
function strtotime(str) {
	return + ((new Date(str.replace(/-/g, "/"))).getTime() / 1e3);
}

/**
 * window.LiveConfig
 * 即时比分 用户配置 设置
 */
(function(config){
	if (!config) {
		config = {};
	}
	window.LiveConfig = {
		get: function(key) {
			key = key.split('.');
			return this.map(key)[key[key.length-1]];
		},
		set: function(key, value) {
			key = key.split('.');
			this.map(key)[key[key.length-1]] = value;
			richStorage.set('liveconfig', config);
		},
		map: function(key, temp) {
			temp = config;
			for (i=0; i<key.length-1; i++) {
				if (temp[key[i]] === undefined) {
					temp[key[i]] = {};
				}
				temp = temp[key[i]];
			}
			return temp;
		},
		init: function(b){ // “显示全部”按钮 将重置赛事筛选(b=true)
			if (window.live_type != this.get('live.type') || ($('#sel_expect').length &&  $('#sel_expect').val() != this.get('live.expect'))) {
				this.set('live.type', window.live_type);
				if ($('#sel_expect').length) {
					this.set('live.expect', $('#sel_expect').val());
				}
				b = true;
			}
			var i, t, defaults = [
				['match.status',  '.+'], // 状态
				['match.leagues', []],   // 联赛
				['match.shows',   null], // 显示
				['match.hides',   null]  // 隐藏
			];
			for (i=0; i<defaults.length; i++) {
				if (b || !this.get(defaults[i][0])) {
					this.set.apply(this, defaults[i]);
				}
			}
			defaults = [
			    ['match.top',    []],   // 置顶
			    ['others.lang',  0],    // 语言
				['others.voice', true], // 进球声音
				['others.win',   true], // 进球弹窗
				['others.card',  true], // 红黄牌
				['others.pk',    true], // 盘口
				['others.rank',  true], // 排名
				['select.voice', '7'],  // 声音选项
				['select.skin',  0],    // 背景皮肤
				['select.win',   '0']   // 弹窗选项
			];
			for (i=0; i<defaults.length; i++) {
				t = this.get(defaults[i][0]);
				if (t===undefined || t===null) {
					this.set.apply(this, defaults[i]);
				}
			}
		},
		// 方案直播时 备份配置
		backup: function(){
			if (!richStorage.get('livebackup')) {
				richStorage.set('livebackup', config);
			}
		},
		// 还原备份配置
		restore: function(){
			if (richStorage.get('livebackup')) {
				richStorage.set('liveconfig', config = richStorage.get('livebackup'));
				richStorage.remove('livebackup');
			}
		}
	};
	LiveConfig.init();
	
	// 方案直播
	if (window.scheme_ids) {
		LiveConfig.backup();
		LiveConfig.init(true);
		LiveConfig.set('match.shows', scheme_ids);
	} else {
		LiveConfig.restore();
	}
	
})(richStorage.get('liveconfig'));

$(function(tb, tr, ptb, ptr, cn){
	"use strict";
	tb = $('#table_match > tbody'); // 比赛表格 tbody
	tr = $('#table_match > tbody > tr[id]'); // 比赛表格 tr
	ptb = $('#table_project'); // 方案表格
	ptr = ptb.find('> tbody > tr[pid]'); // 方案表格 tr
	cn = $('#hide_count'); // 隐藏场次 计数
	// 显示语言（国语、粤语）
	window.LiveLang = {
		Radios: $(document.getElementsByName('check_lang')),
		Selectors : window.live_type=='wanchang' ? // 完场
				['td:eq(0) a', 'td:eq(4) a', 'td:eq(6) a'] :
					(window.live_type=='weekfixture' ? // 未来
						['td:eq(0) a', 'td:eq(3) a', 'td:eq(5) a'] :
							(window.live_type=='ald' ? // ald
									['td:eq(0) a', 'td:eq(4) a', 'td:eq(6) a'] :
										['td:eq(1) a', 'td:eq(5) a', 'td:eq(7) a']))
	};
	
	// 国语、粤语切换
	LiveLang.Radios.click(function(v){
		v = $(this).val() - 0;
		if (!LiveLang.Radios.eq(LiveConfig.get('others.lang')).attr('checked')) {
			LiveConfig.set('others.lang', v);
			tr.each(function(a, i){
				a = $(this).attr(['gy','yy'][v]).split(',');
				for (i=0; i<3; i++) {
					$(LiveLang.Selectors[i], this).html(a[i]);
				}
			});
		}
	});
	// 盘口、球队排名、红牌 选项点击事件
	$('#check_pk,#check_card,#check_rank').click(function(t){
		t = $(this);
		LiveCheck[t.attr('id').replace('check_','')](!!t.attr('checked'));
	});
	// 进球声、弹窗<select>
	$('#sel_voice,#sel_win').change(function(t){
		t = $(this);
		LiveConfig.set(t.attr('id').replace('sel_','select.'), t.val());
	});
	// 背景皮肤
	$('#sel_skin').change(function(t){
		t = ~~ $(this).val();
		LiveConfig.set('select.skin', t);
		setSkin();
	});

	$('#sel_company').change(function(){
		var _cid = $(this).val();
		LiveConfig.set('select.company', _cid);
		$('#table_match').find('tr').each(function(i, n){
			var $_self = $(n).find('td:eq(6) a:eq(1)');
			if (typeof $_self.attr('data-pb') == 'string') {
				$_self.text(_cid == 3 ? $_self.attr('data-pb') : $_self.attr('data-ao'));
			}
		});
	});

	var SKINS = [
				{'background-color':'transparent'},
				{'background-color':'#412182'/*,'background-image':'url('+Base_NIMG+'/lq/index_bg.jpg)'*/},
				{'background-color':'rgb(54, 126, 167)'},
				{'background-color':'rgb(215, 224, 231)'},
				{'background-color':'rgb(79, 96, 25)'}
			];
	function setSkin() {
		if (/[?&]from=[^&]/.test(location.search)) {
			return;
		}
		$(document.body).css('background-image', 'none').css(SKINS[LiveConfig.get('select.skin')]);
	}
	window.LiveCheck = {
		// 球队排名
		rank: function(b){
			tr.each(function(){
				$('td:eq(5) span:first,td:eq(7) span:last', this).toggle(b);
			});
		},
		// 盘口
		pk: function(b){
			tr.each(function(t){
				t = $('td:eq(6) a:eq(1)', this);
				if (b) {
					t.css({'visibility':'visible'});
				} else {
					t.css({'visibility':'hidden'});
				}
			});
		},
		// 红牌
		card: function(b) {
			tr.find('.yellowcard,.redcard').toggle(b);
		}
	};
	
	// 完成比赛排序
	var need_sort = window.live_type=='index'||window.live_type=='zqdc';
	function finished_sort(a, b) {
//		var c = ~~a.find('td:eq(0)').text().match(/[1-9]\d*/)[0] - ~~b.find('td:eq(0)').text().match(/[1-9]\d*/)[0];
		var c = window.live_type=='index' || window.live_type=='zqdc'? (~~a.find('td:eq(0)').text().match(/[1-9]\d*/)[0] - ~~b.find('td:eq(0)').text().match(/[1-9]\d*/)[0]):
				(~~a.attr('id').match(/[1-9]\d*/)[0] - ~~b.attr('id').match(/[1-9]\d*/)[0]);
		return c > 0 ? 1 : (c < 0 ? -1 : 0);
	}
	//获取某场赛事比分数据、赛事说明<tr>标签
	//id: 赛事<tr> id
	function getExtraTr(id){
		return $('tr[parentid='+id+']');
	}
	
	// 表格重绘
	window.draw = function(status_changed,i){
		var _child; //加时比分和赛事说明数据
		if (window.unliving) {
			tb.hide();
			var hides = [],
				shows = [],
				l = LiveConfig.get('match.leagues'); // 联赛筛选
			tr.each(function(t,id){
				t = $(this);
				id = t.attr('id');
				if (in_array(t.attr('lid'), l) != -1) {
					hides.push(id);
				} else {
					shows.push(id);
				}
			});
			// 隐藏
			for (i=0; i<hides.length; i++) {
				$('tr[id='+hides[i]+']').hide();
				//remark 和加时比分数据<tr>
				_child=getExtraTr(hides[i]);
				_child.length&&_child.hide();
			}
			// 显示
			for (i=0; i<shows.length; i++) {
				$('tr[id='+shows[i]+']').show();
				//remark 和加时比分数据<tr>
				_child=getExtraTr(shows[i]);
				_child.length&&_child.show();
			}
			tb.show();
		} else if (!window.is_zc) {
			tb.hide();
			var hides = [],
				shows = [],
				s = new RegExp('^'+LiveConfig.get('match.status')+'$'), // 比赛状态
				l = LiveConfig.get('match.leagues'), // 联赛筛选
				y = LiveConfig.get('match.shows'), // 保留场次
				n = LiveConfig.get('match.hides'), // 隐藏场次
				p = LiveConfig.get('match.top'), q = [], // 置顶
				ald=LiveConfig.get('ald.showm');//阿拉丁处理
			tr.each(function(t,id,t_c){
				t = $(this);
				id = t.attr('id');
				t_c = t.attr("class");
				if (!s.test(t.attr('status')) // 比赛状态
					|| (in_array(t.attr('lid'), l) != -1) // 联赛筛选
					|| (n && in_array(id.substr(1), n) != -1) // 保留场次
					|| (y && in_array(id.substr(1), y) == -1) // 隐藏场次
				) {
					hides.push(id);
				} else {
					if(t_c.indexOf("trhide")>=0)return;//ald处理
					shows.push(id);
				}
				// 排序：进行中
				if (/[1-3]/.test(t.attr('status'))) {
					tb.append(t);
					_child=getExtraTr(id);
					_child.length&&tb.append(_child);
				}
			});
			// 隐藏
			for (i=0; i<hides.length; i++) {
				$('tr[id='+hides[i]+']').hide();
				//remark 和加时比分数据<tr>
				_child=getExtraTr(hides[i]);
				_child.length&&_child.hide();
			}
			// 显示
			for (i=0; i<shows.length; i++) {
				$('tr[id='+shows[i]+']').show();
				//remark 和加时比分数据<tr>
				_child=getExtraTr(shows[i]);
				_child.length&&_child.show();
			}
			
			// 排序：未开赛
			tr.each(function(t){
				t = $(this);
				if (t.attr('status')==0||t.attr("id").indexOf("moreraceWrap1")>=0) {//ald处理
					tb.append(t);
					//remark 和加时比分数据<tr>
					_child=getExtraTr(t.attr('id'));
					_child.length&&tb.append(_child);
				}
			});
			
			// 排序：已完场
			if (need_sort && status_changed) {
				var temp_tr = [];
				tr.each(function(t){
					t = $(this);
					if (t.attr('status')>3) {
						temp_tr.push(t);
					}
				});
				temp_tr.sort(finished_sort);
				for(i=0;i<temp_tr.length;i++) {
					tb.append(temp_tr[i]);
					//remark 和加时比分数据<tr>
					_child=getExtraTr(temp_tr[i].attr('id'));
					_child.length&&tb.append(_child);
				}
			} else {
				tr.each(function(t){
					t = $(this);
					if (t.attr('status')>3||t.attr("id").indexOf("moreraceWrap2")>=0) {//ald处理
						tb.append(t);
						
						//remark 和加时比分数据<tr>
						_child=getExtraTr(t.attr('id'));
						_child.length&&tb.append(_child);
					}
				});
			}
			// 置顶
			for (i=0; i<p.length; i++) {
				var t = $('#'+p[i]);
				if (t.length) {
					t.find('.icon_notop').removeClass('icon_notop').addClass('icon_top');
					
					//remark 和加时比分数据<tr>
					_child=getExtraTr(t.attr('id'));
					_child.length&&tb.prepend(_child);
					
					tb.prepend(t);
					t.addClass('bg_top');
					q.push(p[i]);
				}
			}
			if(ald){
				for(var j=0;j<ald.length;j++){
					$("#"+ald[j]).hide();
				}
			}
			
			LiveConfig.set('match.top', q);
			
			cn.html(hides.length);
			tb.show();
		}
		if (!window.is_zc || window.live_type == 'zucai') {
			// 隔行换色
			tb.children().filter('tr:visible[id]').not('.bg_top').each(function(i){
				i%2 ? $(this).addClass('bg02')
					: $(this).removeClass('bg02');
			});
		}
		// 未完场 比分颜色
		tr.each(function(t,s){
			t = $(this);
			s = t.attr('status');
			if(window.live_type!='ald'){
				if (/[1-3]/.test(s)) {
					$(this).find('td:eq(6) a:eq(0),td:eq(6) a:eq(2)').css('color','blue');
				} else if (s==4) {
					$(this).find('td:eq(6) a:eq(0),td:eq(6) a:eq(2)').css('color','red');
				}
			}
		});

		//方案列表显示
		ptr.each(function() {
			var self = $(this),
				fid = self.attr("fid").split(","),
				i,
				isshow = true;


			for (i=0;i<fid.length;i++){
				if (tr.filter(':visible[fid='+fid[i]+']').length==0){
					isshow = false;
					break;
				}
			}
			self.find("td:last a").html(isshow?'隐藏':'显示');
		});
	};
});

// 筛选比赛
(function(){
	"use strict";
	var Match = {
		// 获取选中的id数组
		get: function(a){
			a = [];
			Match._id.filter(':visible').filter(':checked').each(function(){
				a.push($(this).val());
			});
			return a;
		},
		// 保留选中
		show: function(a){
			a = Match.get();
			if (a.length) {
				LiveConfig.set('match.hides', null);
				LiveConfig.set('match.shows', a);
				
				// TODO: dom operation
				window.draw();
				
				Match.complete();
			}
		},
		// 隐藏选中
		hide: function(a,b){
			a = Match.get();
			if (a.length) {
				LiveConfig.set('match.shows', null);
				b = LiveConfig.get('match.hides');
				if (b) {
					a = a.concat(b);
				}
				LiveConfig.set('match.hides', a);
				
				// TODO: dom operation
				window.draw();
				
				Match.complete();
			}
		},
		// 完成后 恢复按钮为未选中
		complete: function(){
			Match._id.removeAttr('checked');
		}
	};
	
	var League = {
		// 获取当前选中 “比赛状态”
		getStatus: function(){
			return League._status.filter(':checked').val();
		},
		// 选中“比赛状态”
		checkStatus: function(s){
			s = League.getStatus();
			
			// 保存配置
			LiveConfig.set('match.status', s);
			
			// TODO: dom operation
			window.draw();
		},
		getId: function(s) {
			s = [];
			League._id.not(':checked').each(function(){
				s.push($(this).val());
			});
			return s;
		},
		// 选中“联赛id”
		checkId: function(s){
			if (!window.btn_league_clicked) {
				s = League.getId();
	
				// 保存配置
				LiveConfig.set('match.leagues', s);
				
				// TODO: dom operation
				window.draw();
			}
		}
	};

	var Project = {
		//取得方案
		get : function(a){
			a = [];
			Project._id.filter(':visible').each(function() {
				a.push($(this).attr("pid"));
			});
			return a;
		},
		//显示剩余方案
		show : function(a){
			a = Project.get();
			// TODO: dom operation
			var sid = [];
			Project._id.each(function() {
				var self = $(this),
					fids = self.attr("fid").split(","),
					isshow = self.find("td:last a").html() == '隐藏',
					i;
				if (isshow){
					for (i=0;i<fids.length;i++){
						if (fids[i] && in_array(fids[i], sid) == -1){
							sid.push(fids[i]);
						}
					}
				}
			});
			LiveConfig.set('match.hides', null);
			LiveConfig.set('match.shows', sid);

			window.draw();
		}
	}
	
	var live_initialized = false;
	
	// 根据用户配置筛选场次
	function liveInit() {
		if (!window.is_zc) {
			var s = LiveConfig.get('match.status');
			League._status.each(function(){
				if ($(this).val()==s) {
					$(this).attr('checked', 'checked');
				}
			});
			s = LiveConfig.get('match.leagues');
			League._id.each(function(){
				if (in_array($(this).val(), s) != -1) {
					$(this).removeAttr('checked');
				} else {
					$(this).attr('checked', 'checked');
				}
			});
		}
		LiveLang.Radios.eq(LiveConfig.get('others.lang')).click();
		$('#check_voice,#check_win,#check_pk,#check_card,#check_rank').each(function(t,fn){
			t = $(this);
			if (!LiveConfig.get(t.attr('id').replace('check_','others.'))) {
				t.removeAttr('checked');
				if (fn = LiveCheck[t.attr('id').replace('check_','')]) {
					fn(false);
				}
			}
		});
		$('#sel_voice,#sel_win,#sel_skin,#sel_company').each(function(t){
			t = $(this);
			t.val(LiveConfig.get(t.attr('id').replace('sel_','select.')));
		});
		$('#sel_skin').change();
		$('#sel_company').change();
		// TODO: dom operation
		window.draw();
		
		function start() {
			if (window.LiveStart) {
				LiveStart();
			} else {
				setTimeout(start, 10);
			}
		}
		
		if (!live_initialized) {
			live_initialized = true;
			start();
		}
	}
	
	$(function(){
		// 比赛状态选项
		League._status = $(document.getElementsByName('check_status')).click(function(){
			League.checkStatus();
		});
		// 联赛选项
		League._id = $(document.getElementsByName('check_league[]')).click(function(){
			League.checkId();
		});
		window.btn_league_clicked = false;
		// 联赛全选
		$('#btn_league_all').click(function(){
			window.btn_league_clicked = true;
			League._id.each(function(){
				if (!$(this).attr('checked')) {
					$(this).click();
				}
			});
			window.btn_league_clicked = false;
			League.checkId();
		});
		// 联赛反选
		$('#btn_league_opp').click(function(){
			window.btn_league_clicked = true;
			League._id.click();
			window.btn_league_clicked = false;
			League.checkId();
		});
		
		// 比赛场次选项
		Match._id = $(document.getElementsByName('check_id[]'));
		Project._id = $("#table_project > tbody > tr");
		
		var league_handle = false,
			function_handle = false;
		// 赛事选择
		$('#btn_league').add('#btn_league_close').click(function(){
			$('#layer_function').hide();
			$('#layer_league').toggle();
			if (window.AutoFitHeight && $('#layer_league').filter(':visible').length && !league_handle) {
				league_handle = true;
				AutoFitHeight.min($('#layer_league').offset().top+$('#layer_league').height()+20);
			}
		});
		// 功能选择
		$('#btn_function').add('#btn_function_close').click(function(){
			$('#layer_league').hide();
			$('#layer_function').toggle();
			if (window.AutoFitHeight && $('#layer_function').filter(':visible').length && !function_handle) {
				function_handle = true;
				AutoFitHeight.min($('#layer_function').offset().top+$('#layer_function').height()+20);
			}
		});
		// 保留所选
		$('#btn_match_show').click(function(){
			Match.show();
		});
		// 隐藏所选
		$('#btn_match_hide').click(function(){
			Match.hide();
		});
		// 显示全部
		$('#show_all').click(function(){
			LiveConfig.init(true);
			liveInit();
		});

		//方案隐藏
		$(".hidepro").click(function(){
			$(this).html($(this).html()=='隐藏'?'显示':'隐藏');
			Project.show();
		});

		//导入所有方案
		$("#importProject").click(function(){
			var obj = $("#myproject"),
				tb = obj.find("#prolist table > tbody"),
				mask = $(".yclass_mask_panel");
			if (mask.length==0){
				mask = $('<div class="yclass_mask_panel" tabindex="-1" style="display: none;"></div>').appendTo($('body'));
			}

			$.ajax({
				url: './json/realtime.php',
				type: 'GET',
				data : {p:'json', t:2},
				dataType: 'json',
				cache: false,
				timeout: 3e4,
				success: function(data){
			        if (data==-1){
			        	window.location.href = $("#loginbtn_new").attr("href");
			        }else{
			        	tb.html('');
						for (var i=0;i<data.length;i++){
							var d = data[i],
								cla = i==0?' class="first"':'',
								tr_html = '<tr'+cla+'>'+
							        '<td><input type="checkbox" value="'+d["pid"]+'" name="pid[]" checked="checked"></td>'+
							        '<td>'+d["a"]+'</td>'+
							        '<td class="gray">'+d["b"]+'</td>'+
							        '<td>'+d["c"]+'</td>'+
							        '</tr>';
					        tb.append(tr_html);
						}
						obj.screenCenter();
			        }
				}
			});
			obj.find(".import").unbind('click').click(function(){
				var pid = obj.find("input:checked[name='pid[]']"),
					notice = obj.find(".notice"),
					t;
				if (pid.length){
					obj.find("form").submit();
				}else{
					clearTimeout(t);
					notice.html('至少选择一个方案').show();
					t = setTimeout(function(){
						notice.hide();
					}, 500);
				}
			});
			obj.find(".tips_close").unbind('click').click(function(){
				mask.hide();
				obj.hide();
			});
			obj.find(".ck_all").attr("checked", true).unbind('click').click(function(){
				obj.find("input[name='pid[]']").attr("checked", $(this).attr("checked"));
			});
			mask.show();
			obj.screenCenter();
		});
		
		$('#check_voice,#check_win,#check_pk,#check_card,#check_rank').click(function(t){
			t = $(this);
			LiveConfig.set(t.attr('id').replace('check_','others.'), !!t.attr('checked'));
		});
		
		// 置顶
		$('.icon_notop,.icon_top').click(function(t){
			var	t = $(this),
				tr = t.parent().parent(),
				id = tr.attr('id'),
				a = LiveConfig.get('match.top'),
				i = in_array(id, a);
			if (t.hasClass('icon_top')) {
				t.removeClass('icon_top').addClass('icon_notop');
				if (i != -1) {
					a.splice(i, 1);
					LiveConfig.set('match.top', a);
				}
				tr.removeClass('bg_top');
				stat4home('08120102','jsbf_qxzd'); // 统计：取消置顶
			} else {
				t.removeClass('icon_notop').addClass('icon_top');
				if (i == -1) {
					a.push(id);
					LiveConfig.set('match.top', a);
				}
				tr.addClass('bg_top');
				stat4home('08120101','jsbf_zd'); // 统计：置顶
			}
			
			// TODO: dom operation
			window.draw();
		});
		
		// 根据用户配置 初始化筛选场次
		liveInit();
	});
})();

$(function(){
	"use strict";
	var tb = $('#table_match'), // 比赛表格 table
		_tr = tb.find('> tbody > tr[id]'), // 比赛表格 tr
		ptb = $('#table_project'), // 方案表格
		_ptr = ptb.find('> tbody > tr[pid]'), // 方案表格 tr
		modified = 1, status_changed = false, live_handle = false, score_changed = 0, SWF,
		Stats = ['未','上半场','中场','下半场','完','取消','改期','腰斩','中断','待定','加时赛开始','加时赛结束', '点球'],
		Positions = ['100001','001001','000110','010010','100100','110000','001100','011000'],
		CssNames = ['top','right','bottom','left'],
		Selectors = {
			status: 'td:eq(4)',
			home: 'td:eq(6) a:eq(0)',
			away: 'td:eq(6) a:eq(2)',
			yapan: 'td:eq(6) a:eq(1)',
			half: 'td:eq(8)',
			homerank: 'td:eq(5) .gray',
			awayrank: 'td:eq(7) .gray',
			rq: 'td:eq(9)',
			result: 'td:eq(11)'
		},
		_yapan_table = $('#yapan_table'),
		_yapan_tip = $('#yapan_tip'),
		_yapan_init,
		_yapan_ajax,
		_count = 1,
		getResult,
		setOdds = function(){};
	
	if (window.live_type == 'index' || window.live_type == 'zqdc') {
		Selectors.rq = 'td:eq(5) span.sp_rq,td:eq(5) span.sp_sr';
		Selectors.result = 'td:eq(10)';
		Selectors.odds = 'td:eq(9)';
		var oddsType;
		var odds = (function(list){
			var odds = {};
			if (list) {
				if (list instanceof Array) {
					for (var i = 0; i < list.length; ++ i) {
						for (var key in list[i]) {
							odds[key] = list[i][key];
						}
					}
				} else {
					for (var key in list) {
						odds[key] = list[key];
					}
				}
			}
			return odds;
		})(window.liveOddsList);
		
		// 各玩法赛果切换
		$('#sel_result').change(function(){
			var type = + $(this).val();
			if (type > 0 && window.stat4home) {
				// 统计
				stat4home('08120'+(live_type=='index'?'3':'2')+'0'+type,(live_type=='index'?'index':'zqdc')+'_'+['','jqs','bf','bqc','sxds'][type]);
			}
			
			_tr.filter("[status='4']").each(function(){
				var tr = $(this);
				tr.find(Selectors.result).html(getResult(type, tr));
			});
			if (live_type == 'index') {
				if (type == 0 || type == 5) {
					var next = type == 0 ? 'rqsp' : 'sp';
					if (next != oddsType) {
						selOdds.val(next);
						setOdds();
					}
				}
			}
			tb.toggleClass('bf_table_rq', type == 0);
			
			_tr.each(function(){
				var $_td = $(this).find('td').eq(10), _text = $.trim($_td.text());
				if($_td.attr('def')){
					$_td.html(_text +' '+$_td.attr('def'));
				}
			});
		});
		
		// 计算各玩法赛果
		var win_other_max = live_type == 'index' ? 5 : 4;
		getResult = function(type, tr){
			if (tr.attr('status') != '4') {
				return '';
			}
			var half = tr.find(Selectors.half).text().split(' - '),
				h = [tr.find(Selectors.home).text(),half[0]],
				a = [tr.find(Selectors.away).text(),half[1]],
				r = tr.find(Selectors.rq),
				temp, t;
			r = r.length > 0 ? r.text().replace(/[\+\(\)]/g, '') : '0';
			switch (type) {
				case 0: // 让球胜平负
					if (/^[\+\-]?\d*$/.test(r)) {
						temp = (~~h[0]) - (~~a[0]) + (+ r);
						t = temp > 0 ? '胜' : (temp < 0 ? '负' : '平');
					} else {
						t = '';
					}
					break;
				case 1: // 进球
					temp = (~~h[0])+(~~a[0]);
					t = temp > 6 ? '7+' : temp;
					break;
				case 2: // 比分
					var _h = ~~h[0], _a = ~~a[0];
					if (_h == _a) {
						t = _h > 3 ? '平其他' : _h+':'+_a;
					} else if (_h > _a) {
						t = _a > 2 || _h > win_other_max ? '胜其他' : _h+':'+_a;
					} else {
						t = _h > 2 || _a > win_other_max ? '负其他' : _h+':'+_a;
					}
					break;
				case 3: // 半全场
					temp = h[1] - a[1];
					t = temp > 0 ? '胜' : (temp < 0 ? '负' : '平');
					temp = h[0] - a[0];
					t += temp > 0 ? '胜' : (temp < 0 ? '负' : '平');
					break;
				case 4: // 上下单双
					temp = (~~h[0])+(~~a[0]);
					t = (temp > 2 ? '上' : '下') + (temp % 2 ? '单' : '双');
					break;
				case 5: // 胜平负
					temp = (~~h[0]) - (~~a[0]);
					t = temp > 0 ? '胜' : (temp < 0 ? '负' : '平');
			}
			return t;
		};
		
		setOdds = function(){
			oddsType = selOdds.val();
			_tr.each(function(){
				var tr = $(this),
					fid = tr.attr('fid'),
					status = tr.attr('status'),
					reversed = 0,
					td = tr.find(Selectors.odds),
					html = [];
				if (fid in odds && oddsType in odds[fid]) {
					var data = odds[fid][oddsType].slice(0),
						temp = data.slice(0),
						results = ['胜', '平', '负'],
						end = status == '4';
					temp.sort(asc);
					var onlyone = (temp[0] <= 0 && temp[1] <= 0 && temp[2] > 0);
					if (reversed && /^\d+$/.test(oddsType)) {
						data.reverse();
					}
					var result = getResult(oddsType == "rqsp" ? 0 : 5, tr);
					for (var i = 0; i < 3; ++ i) {
						html.push(getOddsItem(data[i], data[i] > 0 && ((end && result == results[i]) || onlyone)));
					}
				} else {
					html.push('<span style="width:23px;">-</span><span style="width:23px;">-</span><span style="width:23px;">-</span>');
				}
				td.html(html.join(''));
			});
		};
		
		var asc = function(a, b) {
			return a - b;
		};
		
		var getOddsItem = function(value, hit) {
			return '<span' + (hit ? ' class="op4"' : (value > 0 ? '' : ' style="width:23px;"')) + '>' + (value > 0 ? parseFloat(value).toFixed(2) : '-') + '</span>';
		};
		
		// 指数切换
		var selOdds = $('#sel_odds').change(setOdds);
		//足球单场赛程html静态文件默认有提供sp值,无须设置
		window.live_type!='zqdc' && setOdds();
	}

	//方案状态
	(function(){
		if (ptb.length){
			_ptr.hover(function() {
				var self = $(this),
					fids = self.attr("fid").split(","),
					i;
				for (i=0;i<fids.length;i++){
					_tr.filter("[fid="+fids[i]+"]").css("background-color", "#FFFCC5");
				}
				$(this).css("background-color", "#FFFCC5");
			}, function() {
				_tr.css("background-color", "");
				_ptr.css("background-color", "");
			});
		}
	})();
	/*
	if (! window.unliving) {
		var hasVideo = false,
			videoRows = $();
		_tr.each(function(i){
			var tr = _tr.eq(i),
				status = + tr.attr('status'),
				sid = + tr.attr('sid');
			if (status < 4 && sid == 2776) {
//				tr.attr("video", "1");
				videoRows = videoRows.add(tr);
				hasVideo = true;
			}
		});
		
		if (hasVideo) {
			var tpl = '<a href="http://ssports.smgbb.cn/Live/zhibo/id/{$vid}?source=500WAN" target="_blank" class="live_video" onclick="stat4home(\'20130547\',\'zhibo_jsbf\')">直播</a>',
				showVideo = function(){
					var map = window.live_video_map,
						type = window.live_type;
					videoRows.each(function(i){
						var tr = videoRows.eq(i),
							status = + tr.attr('status'),
							vid = map[tr.attr('fid')],
							elem;
						if (status < 4 && vid) {
							switch (type) {
								case 'index': case 'zqdc':
									elem = tr.find(Selectors.result);
									break;
								case 'zucai':
									elem = tr.find('td:eq(10) strong');
									break;
								case '6chang': case '4chang':
									elem = tr.next().find('strong');
									break;
								default:
									elem = tr.find('td:eq(9)');
							}
							elem.html(tpl.replace('{$vid}', vid));
						}
					});
				};
			try {
				runScript(_configs.base_cache + '/live/js/live-video.js', showVideo);
			} catch (e) {}
		}
	}*/
	
	// 盘口浮动层
	function pankou(d) {
		var i, f, e, r, s, t, $obj=$('#yapan_table').find('tr:eq(0)');

		$obj.find('th:eq(1)').html('即时指数').next().html('初盘指数');
		$('#yapan_table').removeClass('pingbo');
		
		if (d) {
			for (i=0; i<3; ++i) {
				if (d[i]) {
					f = d[i][0];
					e = d[i][1];
					r = e[0] - f[0];
					s = e[1] - f[1];
					t = e[2] - f[2];
					_yapan_table.find('tr:eq('+(i+1)+') td:eq(1)').html(
						'<div class="odds_sp_left'+(r>0?' odds_sp_up':(r<0?' odds_sp_down':''))+'">'+parseFloat(e[0]).toFixed(i?2:3)+'</div>'
						+'<div class="odds_sp_center">'+(i==1?('<div class="odds_sp_middle'+(s>0?' odds_sp_up':(s<0?' odds_sp_down':''))+'">'+parseFloat(e[1]).toFixed(2)+'</div>'):e[1])+'</div>'
						+'<div class="odds_sp_right'+(t>0?' odds_sp_up':(t<0?' odds_sp_down':''))+'">'+parseFloat(e[2]).toFixed(i?2:3)+'</div>'
					);
					_yapan_table.find('tr:eq('+(i+1)+') td:eq(2)').html(
						'<div class="odds_sp_left">'+parseFloat(f[0]).toFixed(i?2:3)+'</div>'
						+'<div class="odds_sp_center">'+(i==1?parseFloat(f[1]).toFixed(2):f[1])+'</div>'
						+'<div class="odds_sp_right">'+parseFloat(f[2]).toFixed(i?2:3)+'</div>'
					);
				} else {
					_yapan_table.find('tr:eq('+(i+1)+') td:eq(1)').html('暂无数据');
				}
			}
		}
	}
	
	// 盘口浮动层
	if (!window.unliving) {
		_yapan_init = $('#yapan_table').html();
		_tr.find(Selectors.yapan).hover(function(){
			var self = $(this),
				td = self.parent().parent(),
				tr = td.parent(),
				id = tr.attr('fid'),
				off = td.offset(),
				r = /r=-1/.test(self.attr('href')),
				home = 'home',
				away = 'away';
			if (self.text() == '-') {
				return;
			}
			$('#yapan_table').html(_yapan_init);
			_yapan_tip.show().css({
				top: off.top+td.height(),
				left: off.left-150
			});
			$('#yapan_'+home).html(tr.find('td:eq(5) a').text());
			$('#yapan_score').html(tr.find(Selectors[home]).text()+' - '+tr.find(Selectors[away]).text());
			$('#yapan_'+away).html(tr.find('td:eq(7) a').text());
			if (window.AutoFitHeight) {
				if (_yapan_tip.offset().top+_yapan_tip.height() > $(document.body).height() + 10) {
					var _top = _yapan_tip.offset().top - 180;
					if (_top < 0) {
						AutoFitHeight.min(_yapan_tip.offset().top+_yapan_tip.height()+10);
					} else {
						_yapan_tip.css({top: _top});
					}
				}
			}
			if (_yapan_ajax) {
				try {
					_yapan_ajax.abort();
				} catch(e){}
			}
			var _cid = $('#sel_company').size() > 0 ? $('#sel_company').val() : 3;
			_yapan_ajax = $.ajax({
				url: './json/odds.php?fid='+id+'&cid='+_cid+(r?'&r=-1':''),
				dataType: 'json',
				success: pankou
			});
		},function(){
			_yapan_tip.hide();
		});
	}
	
	// 更新比赛计时
	function setTime(td, time, status){
		var now = ~~((new Date).getTime() / 1000)+time_offset;
		var minutes = ~~((now - strtotime(time)) / 60);
		minutes = minutes < 1 ? 1 : minutes;
		if (minutes >= 46) {
			td.html(status==3 ? "90+'" : "45+'");
		} else {
			if (status==3) {
				minutes += 45;
			}
			td.html(minutes+"'");
		}
	}
	
	// 更新进球
	function score(a,td,h,n,t) {
		t = a.html();
		if (live_handle && t != '' && t != h) {
			clearTimeout(td.attr('timeout'));
			td.css('background-color','#CC0').attr('timeout', setTimeout(function(){
				td.css('background-color','');
			}, 6e4));
			score_changed = score_changed | n;
		}
		a.html(h);
	}
	
	// 进球弹窗定位
	function position(tip, p) {
		tip.show();
		if ($.browser.msie && 7 > ~~$.browser.version) {
			tip.css('position', 'absolute');
			var t = $(document).scrollTop(),
				l = $(document).scrollLeft(),
				w = document.documentElement.clientWidth-tip.width(),
				h = document.documentElement.clientHeight-tip.height();
			if (p.charAt(0)=='1') {
				tip.css('top', t);
			}
			if (p.charAt(1)=='1') {
				tip.css('left', l + w);
			}
			if (p.charAt(2)=='1') {
				tip.css('top', t + h);
			}
			if (p.charAt(3)=='1') {
				tip.css('left', l);
			}
			if (p.charAt(4)=='1') {
				tip.css('top', t + ~~(h/2));
			}
			if (p.charAt(5)=='1') {
				tip.css('left', l + ~~(w/2));
			}
		} else {
			tip.css('position', 'fixed');
			for (var i=0; i<4; i++) {
				tip.css(CssNames[i], p.charAt(i)=='1' ? 0 : 'auto');
			}
			if (p.charAt(4)=='1') {
				tip.css('top', ~~((document.documentElement.clientHeight - tip.height())/2));
			}
			if (p.charAt(5)=='1') {
				tip.css('left', ~~((document.documentElement.clientWidth - tip.width())/2));
			}
		}
	}

	//方案过关
	function fagg(){
		var pids = [];
		_ptr.each(function() {
			pids.push($(this).attr('pid'));
		});
		$.ajax({
			url: './json/realtime.php',
			type: 'GET',
			data : {p:'json', pid:pids},
			dataType: 'json',
			cache: false,
			timeout: 3e4,
			success: function(data){
				for (var i=0;i<data.length;i++){
					var d = data[i],
						tr = _ptr.filter("[pid="+d["pid"]+"]"),
						td = tr.find("> td");

					if (tr.length>0){
						td.eq(2).html(d["c"]);
					}
				}
			}
		});
	}

	// 进球效果
	function goal(tr, n) {
		if (LiveConfig.get('others.win')) {
			var tip = $('#goal_tip'), td = tip.find('td');
			clearTimeout(tip.attr('timeout'));
			td.eq(0).html(tr.find('td:eq(1) a').text());
			var t = tr.find('td:eq(0)').text();
			t = window.live_type == 'zqdc' ? '第<span class="red">'+t+'</span>场' : t;
			td.eq(1).html(t);
			td.eq(2).html(tr.find('td:eq(4)').text());
			td.eq(3).html(tr.find('td:eq(5) a').text()).css('color', (n&2)==2 ? 'red' : '#333');
			td.eq(4).find('span').eq(0).html(tr.find(Selectors.home).text()).css('color', (n&2)==2 ? 'red' : 'blue');
			td.eq(4).find('span').eq(1).html(tr.find(Selectors.away).text()).css('color', (n&1)==1 ? 'red' : 'blue');
			td.eq(5).html(tr.find('td:eq(7) a').text()).css('color', (n&1)==1 ? 'red' : '#333');
			position(tip, Positions[LiveConfig.get('select.win')]);
			// 10秒后隐藏
			tip.attr('timeout', setTimeout(function(){tip.hide();},1e4));
		}
		if (LiveConfig.get('others.voice')) {
			play();
		}
	}
	
	// 播放声音
	function play() {
		if (!SWF) {
			SWF = $(document.createElement('div'));
			if ($.browser.msie) {
				SWF.hide();
			
			// ！！！非IE浏览器 隐藏的flash不能播放
			} else {
				SWF.css({position:'absolute',width:'23px',height:'12px',top:'-9999px',left:'-9999px'});
			}
			$(document.body).append(SWF);
		}
		var swf = '/images/sound'+($('#sel_voice').val() || LiveConfig.get('select.voice'))+'.swf';
		SWF[0].innerHTML = '<object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000" width="23" height="12" codebase="http://download.macromedia.com/pub/shockwave/cabs/flash/swflash.cab#version=9,0,28,0"><param name="quality" value="high" /><param name="wmode" value="transparent" /><param name="movie" value="' + swf + '" /><embed src="' + swf + '" quality="high" width="23" height="12" pluginspage="http://www.adobe.com/shockwave/download/download.cgi?P1_Prod_Version=ShockwaveFlash" type="application/x-shockwave-flash"></embed></object>';
	}
	
	// 切换声音
	$('#sel_voice').change(play);
	
	// 更新单个比赛信息
	function item(d, b, tr, st, h, a, sp){
		tr = $('#a'+d[0]);
		if (tr.length) {
			// 主客是否相反
			var ir = !b||tr.attr('r')!='-1';
			h = d[ir?2:3].split(',');
			a = d[ir?3:2].split(',');
			
			// 进球
			score_changed = 0;
			score(tr.find(Selectors.home), tr.find('td:eq(5)'), h[0], 2);
			score(tr.find(Selectors.away), tr.find('td:eq(7)'), a[0], 1);
			if (live_handle && score_changed && tr.filter(':visible').length) {
				goal(tr,score_changed);
			}
			// 红黄牌显示
			var style = LiveConfig.get('others.card') ? '' : ' style="display:none"';
			// 半场赛果
			tr.find(Selectors.half).html(d[1]<5&&d[1]>1?h[1]+' - '+a[1]:' - ');
			
			var ht = tr.find('td:eq(5)'), // 主队td
				at = tr.find('td:eq(7)'), // 客队td
				hr = tr.find(Selectors.homerank), // 主队排名
				ar = tr.find(Selectors.awayrank); // 客队排名
			// 主队红牌
			sp = ht.find('.redcard');
			if (h[2] > 0) {
				if (sp.length) {
					sp.html(h[2]);
				} else {
					sp = ht.find('.yellowcard');
					if (!sp.length) {
						sp = hr;
					}
					sp.after('<span class="redcard"'+style+'>'+h[2]+'</span>');
				}
			} else {
				sp.remove();
			}
			// 客队红牌
			sp = at.find('.redcard');
			if (a[2] > 0) {
				if (sp.length) {
					sp.html(a[2]);
				} else {
					sp = at.find('.yellowcard');
					if (!sp.length) {
						sp = ar;
					}
					sp.before('<span class="redcard"'+style+'>'+a[2]+'</span>');
				}
			} else {
				sp.remove();
			}

			// 主队黄牌
			sp = ht.find('.yellowcard');
			if (h[3] > 0) {
				if (sp.length) {
					sp.html(h[3]);
				} else {
					hr.after('<span class="yellowcard"'+style+'>'+h[3]+'</span>');
				}
			} else {
				sp.remove();
			}
			// 客队黄牌
			sp = at.find('.yellowcard');
			if (a[3] > 0) {
				if (sp.length) {
					sp.html(a[3]);
				} else {
					ar.before('<span class="yellowcard"'+style+'>'+a[3]+'</span>');
				}
			} else {
				sp.remove();
			}
			
			st = tr.find(Selectors.status);
			// 进行中状态效果
			if (!tr.attr('living') || tr.attr('status') != d[1]) {
				switch (~~d[1]) {
					case 1: case 3:
						st.addClass('td_living');
						break;
					default:
						st.removeClass('td_living');
				}
			}
			
			// 进行中比赛计时
			if (!tr.attr('living')) {
				tr.attr('living', '1');
				clearTimeout(tr.attr('timeout'));
				switch (~~d[1]) {
					case 1: case 3:
						setTime(st, d[4], d[1]);
						tr.attr('time', d[4]);
						tr.attr('timeout', setInterval(function(){
							setTime(st, d[4], d[1]);
						}, 3e3));
						break;
					case 2:
						st.html('<span style="color:blue">中</span>');
						break;
				}
			}
			var result, old_status = tr.attr('status');
			// 需重绘表格
			if (!status_changed && old_status != d[1] && !(/[1-3]/.test(old_status) && /[1-3]/.test(d[1]))) {
				status_changed = true;
			}
			
			// 需切换状态/更新赛果
			if (old_status != d[1] || (!b && /[1-3]/.test(d[1])) || tr.attr('time') != d[4]) {
				tr.attr('status', d[1]);
				clearInterval(+ tr.attr('timeout'));
				switch (~~d[1]) {
					case 1: case 3:
						setTime(st, d[4], d[1]);
						tr.attr('time', d[4]);
						tr.attr('timeout', setInterval(function(){
							setTime(st, d[4], d[1]);
						}, 3e3));
						break;
					case 2:
						st.html('<span style="color:blue">中</span>');
						break;
					case 0:
						st.html('未');
						break;
					case 4:
						// 完场赛果
						switch(live_type) {
							case 'index': case 'zqdc':
								tr.find(Selectors.result).html(getResult(+ $('#sel_result').val(), tr));
//								setOdds();
								break;
							case 'zucai':
								result = h[0] - a[0];
								tr.find('td:eq(10) strong').html(result>0 ? '3' : (result<0 ? '0' : '1'));
								break;
							case '6chang':
								result = h[0] - a[0];
								tr.next().find('strong').html(result>0 ? '3' : (result<0 ? '0' : '1'));
								break;
							case '4chang':
								tr.find('td:eq(10) strong').html(3 > ~~h[0] ? h[0] : 3);
								tr.next().find('strong').html(3 > ~~a[0] ? a[0] : 3);
						}
						st.html('<span class="red">'+Stats[d[1]]+'</span>');
						break;
					default:
						st.html('<span class="red">'+Stats[d[1]]+'</span>');
				}
				if (d[1] > '0') {
					// 亚盘灰掉
					tr.find(Selectors.yapan).removeClass('fgreen').addClass('fhuise');
				}
			}
			switch (~~d[1]) {
				case 4:
					// 平均赔率
					if (window.is_zc) {
						result = h[0] - a[0];
						var pl_i = result > 0 ? 0 : (result < 0 ? 2 : 1),
							pls = [],
							sp = tr.find('td:last span'),
							cn = 'op1';
						sp.each(function(){
							pls.push($(this).text()-0);
						});
						if (pls[pl_i] == Math.min.apply(Math, pls)) {
							cn = 'op3';
						} else if (pls[pl_i] == Math.max.apply(Math, pls)) {
							cn = 'op0';
						}
						sp.eq(pl_i).addClass(cn);
					}
				case 2: case 3:
					// 半场赛果
					if (live_type == '6chang') {
						result = h[1] - a[1];
						tr.find('td:eq(10) strong').html(result>0 ? '3' : (result<0 ? '0' : '1'));
					}
					break;
				case 1:
					break;
				default:
					// 未开赛或非正常
					tr.find(Selectors.home+','+Selectors.away).html('');
			}
			// //视频入口
			// var live_td,//视频td对象
			// 	_eq=0,//视频td下标
			// 	_i = !b&&live_json_path.indexOf('jczq') != -1?6:5,//竞足完整txt文件与其他txt文件格式不一致
			// 	html_arr=[],
			// 	live_arr=[],
			// 	_txt,
			// 	detail_url=$(tr.find('td:eq(6) a')[0]).attr('href');//runningball视频入口
			// if(live_json_path.indexOf('all') != -1) {
			// 	_eq = 12;
			// }else if(live_json_path.indexOf('zqdc') != -1 || live_json_path.indexOf('sfc') != -1 || live_json_path.indexOf('jczq') != -1){
			// 	_eq=10;
			// }
			// if(_eq>0){
			// 	live_td=tr.find('td:eq('+_eq+')');
			// 	_txt=live_td.text(); //获取原始内容(除去html标签并过滤空格)
			// 	if(_txt){
			// 		//足彩页面赛果标红
			// 		html_arr.push(live_json_path.indexOf('sfc') != -1? ('<strong class="red">'+_txt+'</strong>'):_txt);
			// 	}
			// 	switch(~~d[1]){
			// 		case 0: //未开始
			// 			//if(d[_i]){//赛前视频
			// 			//	live_arr.push('<a class="live_video" title="视频" href="http://live.500.com/tv/'+d[0]+'/1/" target="_blank"></a>');
			// 			//}
			// 			if(~~d[_i+3]){//runningball
			// 				live_arr.push('<a class="live_animate" title="动画" href="'+detail_url+'" target="_blank"></a>');
			// 			}
			// 			break;
			// 		case 1:
			// 		case 2:
			// 		case 3:
			// 			//if(d[_i+1]){//赛中视频
			// 			//	live_arr.push('<a class="live_video" title="视频" href="http://live.500.com/tv/'+d[0]+'/2/" target="_blank"></a>');
			// 			//}
			// 			if(~~d[_i+3]){//runningball
			// 				live_arr.push('<a class="live_animate" title="动画" href="'+detail_url+'" target="_blank"></a>');
			// 			}
			// 			break;
			// 		case 4: //结束
			// 			//if(d[_i+2]){//赛后视频
			// 			//	live_arr.push('<a class="live_video" title="视频" href="http://live.500.com/tv/'+d[0]+'/3/" target="_blank"></a>');
			// 			//}
			// 			break;
			// 	}
			// 	//将视频连接添加到def属性中
			// 	live_td.attr('def',live_arr.join(' '));
			// 	//合并数组
			// 	html_arr=html_arr.concat(live_arr);
			// 	//显示视频连接
			// 	live_td.html(html_arr.join(' '));
			// }
			if(window.live_type!='4chang' && window.live_type!='6chang'){
				//加时比分数据
				var _child=$('tr[parentid=a'+d[0]+']'),
					data_index=!b&&window.live_type == 'index'?10:9,
					cols_num=window.live_type == 'index' || window.live_type =='zqdc'?13:(window.live_type=='wanchang'?9:12),
					extra_info=d[data_index].split(','),
					ot_statusid=~~extra_info[0],
					html_arr=[],
					_tr_child;
				
				switch(ot_statusid){
					case 10://加时开始
						html_arr.push('<font color="#A52A2A">90分钟['+h[0]+'-'+a[0]+']</font> <font color="blue">120分钟['+extra_info[1]+'-'+extra_info[2]+']</font>');
						break;
					case 11://加时结束
						html_arr.push('<font color="#A52A2A">90分钟['+h[0]+'-'+a[0]+']</font> <font color="#A52A2A">120分钟['+extra_info[1]+'-'+extra_info[2]+']</font>');
						break;
					case 12://点球开始
						if(extra_info[1]=="-1"&&extra_info[1]=="-1"){
							html_arr.push('<font color="#A52A2A">90分钟['+h[0]+'-'+a[0]+']</font> <font color="blue">点球['+extra_info[3]+'-'+extra_info[4]+']</font>');
						}else{
							html_arr.push('<font color="#A52A2A">90分钟['+h[0]+'-'+a[0]+']</font> <font color="#A52A2A">120分钟['+extra_info[1]+'-'+extra_info[2]+']</font> <font color="blue">点球['+extra_info[3]+'-'+extra_info[4]+']</font>');
						}						
						break;
					case 13: //点球结束
						if(extra_info[1]=="-1"&&extra_info[1]=="-1"){
							html_arr.push('<font color="#A52A2A">90分钟['+h[0]+'-'+a[0]+']</font> <font color="#A52A2A">点球['+extra_info[3]+'-'+extra_info[4]+']</font>');
						}else{
							html_arr.push('<font color="#A52A2A">90分钟['+h[0]+'-'+a[0]+']</font> <font color="#A52A2A">120分钟['+extra_info[1]+'-'+extra_info[2]+']</font> <font color="#A52A2A">点球['+extra_info[3]+'-'+extra_info[4]+']</font>');
						}						
						break;
				}
				//赛事说明
				if(d[data_index+1]){
					html_arr.push('<font color="#A52A2A">'+d[data_index+1]+'</font>');
				}
				if(html_arr.length){
					//如果有加时或赛事说明数据,则显示;
					if(_child.length){
						_child.html('<td colspan="'+cols_num+'">'+html_arr.join('<br/>')+'</td>');
					}else{
						_tr_child=$('<tr parentid="a'+d[0]+'" style="text-align:center"></tr>');
						_tr_child.html('<td colspan="'+cols_num+'">'+html_arr.join('<br/>')+'</td>');
						$(tr).after(_tr_child);
					}
				}else if(_child.length){
					//如果无加时和赛事说明数据且存放数据的tr标签存储,则进行移除
					_child.remove();
				}
			}			
		}
	}
	
	// 根据json数据更新多个比赛信息
	function update(d,s,b,i){
		b = b !== 1;
		if (s!='notmodified' && d) {
			status_changed = false;
			for (i=0; i<d.length; i++) {
				item(d[i], b);
			}
			if (status_changed) {
				// TODO: dom operation
				setOdds();
				window.draw(true);
			}
			
			// 一二三赔计数
			if (window.is_zc) {
				$('#pl_op3').html(tb.find('.op3').length);
				$('#pl_op1').html(tb.find('.op1').length);
				$('#pl_op0').html(tb.find('.op0').length);
			}
		}
		if (b) {
			setTimeout(function(){
				live_handle = true;
			}, 2500);
		}
	}
	
	// 加载full json数据初始化
	function init(d){
		update(d,'',1);
	}
	
	// 即时比分定时更新请求
	function auto(p){
//		var v = _count%100 ? 'all/Live' : p+'Full';
		$.ajax({
			url: '/static/info/bifen/xml/livedata/all/Live.txt',
			dataType: 'json',
			ifModified: true,
			timeout: 5e3,
			success: update,
			complete: function(){
				setTimeout(function(){auto(p);}, 1000);
//				_count ++;
			},
			// IE进程 首次ajax请求同一url会忽略ifModified设置，都会直接读取缓存（不发生请求）
			beforeSend: function(x){
				if (modified) {
					x.setRequestHeader('If-Modified-Since','0');
					modified = 0;
				}
			}
		});
	}
	
	function live_start(p, b) {
		if (p) {
			$.ajax({
				url: '/static/info/bifen/xml/livedata/'+p+'Full.txt',
				dataType: 'json',
				cache: false,
				timeout: 3e4,
				success: init,
				complete: function(){
					if (!b) {
//						auto(p);
						// websocket();
					}
				}
			});
		}
	}
	
	// 开始直播
	window.LiveStart = function() {
		if (!window.unliving) {
			live_start(window.live_json_path);
			live_start(window.live_json_path2, true);
			setTimeout(function(){location.reload();},2e6);
		}
	};
	function websocket(){
		//连接websocket后端服务器
		var host = location.host.indexOf('boss.com')==-1?'500.com':'500boss.com';
		var wss = window.location.protocol =='http:'?'ws':'wss',
			socket = io.connect(wss+'://livews.'+host);
//		//监听新用户登录
//		socket.on('login', function(msg){
//			window.console? console.log(msg):alert(msg);
//		});
		//获取live.txt数据
		socket.on('init',function(msg){
			var d=JSON.parse(msg);
			update(JSON.parse(d['data']));
		});
		//监听变化的数据
		socket.on('change',function(msg){
			var d=JSON.parse(msg);
			update(JSON.parse(d['data']));
		});
	}
});

function expect_change(t) {
	t = $(this);
	if (/[\?&]e=[^&]*/.test(location.search)) {
		location.search = location.search.replace(/([\?&])e=[^&]*/, '$1e='+t.val()).replace(/([\?&])ids=[^&]*/, '$1');
	} else {
		location.search = '?e='+t.val();
	}
	t.attr('disabled','disabled');
}

// 期号列表
if (window.live_expect_path || window.live_expect_list) {
	if(window.live_expect_path){
		$(function(){
			var e = $('#sel_expect').val();
			$.ajax({
				url: '/static/info/bifen/xml/livedata/'+window.live_expect_path+'/expect.xml',
				ifModified: true,
				timeout: 3e4,
				success: function(x){
					var a = [], n;
					$(x).find('row:lt(10)').each(function(m){
						a.push(m = $(this).attr('expect'));
						if ($(this).attr('active')==1) {
							n = m;
						}
					});
					if (in_array(e, a)==-1) {
						a.push(e);
					}
					a.sort().reverse();
					var ops = [];
					for (var i=0; i<a.length; i++) {
						ops.push('<option value="'+a[i]+'"'+(a[i]==e?' selected="selected"':'')+(a[i]==n?' style="color:red"':'')+'>'+a[i]+'</option>');
					}
					$('#sel_expect').html(ops.join('')).change(expect_change);
				}
			});
		});
	}else{
		//足球单场页面
		var ops = [],
			e = $('#sel_expect').val(), //用户选择的期号或默认期号
			n =  window.live_cur_expect||'', //足球单场当前期
			a=window.live_expect_list; //期号列表
		for (var i=0; i<a.length; i++) {
			ops.push('<option value="'+a[i]+'"'+(a[i]==e?' selected="selected"':'')+(a[i]==n?' style="color:red"':'')+'>'+a[i]+'</option>');
		}
		$('#sel_expect').html(ops.join('')).change(expect_change);
	}	
}
(function(){//平博业务
	if (window.live_expect_path == 'sfc' || window.live_expect_path == 'zc6' || window.live_expect_path == 'jq4'){
		$('#close_div').click(function(){
			$(this).parent().hide();
			$('#company_a').removeClass('btn_select_over');
		});
		$('#company_a').click(function(){
			if ($(this).attr('class').indexOf('btn_select_over') != -1){
				$(this).removeClass('btn_select_over').next().hide();
			} else {
				$(this).removeClass('btn_select_over').addClass('btn_select_over').next().show();
			}
		});
	}
})();

//情报数据添加

$(function(){
    var fid_arr = [],
        param='',
        wx_url='';
    $("#table_match tr").each(function(){
        var fid = $(this).attr("fid");
        if(fid){
            fid_arr.push(fid);
        }
    });
    if(fid_arr){
		var host = location.host.split('.').slice(-2,-1)[0];
        param = encodeURIComponent('gameidlist='+ (fid_arr.join(',')));
        wx_url = '//wx.'+host+'.com/port/qing.php?act=qing&param='+ param;
        $.ajax({
             type: "get",
             async: false,
             url: wx_url,
             dataType: "jsonp",
             jsonp: "callback",
             jsonpCallback:"",
             success: function(d){
                 if(d['code'] == 100){
                	var allData = d['data'];
                    for(var i in allData){
                        if(parseInt(allData[i])==1){
                            $("#qing_"+i).removeClass("hide");
                        }
                    }
                 }
             },
             error: function(){
                 console.log('fail');
             }
         });
    }  
});