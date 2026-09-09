/**
 * 提供与宿主约定一致的空值判断能力，避免各模块重复实现。
 * @author ygw
 */
export const ObjectUtils = {
    /**
     * 判断值是否为空。
     * @param value 任意待判断值。
     * @returns {boolean} 值为空时返回 true。
     */
    isEmpty(value) {
        return value === undefined || value === null || value === "";
    }
};
//# sourceMappingURL=object-utils.js.map